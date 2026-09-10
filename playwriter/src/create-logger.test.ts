import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createFileLogger } from './create-logger.js'
import { makeTestTmpDir, removeTestTmpDir } from './test-tmp.js'

function makeTmpDir() {
  return makeTestTmpDir('file-logger')
}

function readLines(logFile: string): string[] {
  return fs
    .readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter((line) => {
      return line.length > 0
    })
}

describe('file logger', () => {
  it('flushes buffered lines to disk', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'relay.log')
    const logger = createFileLogger({ logFilePath: logFile })

    await logger.log('first line')
    await logger.log('second', { nested: true })
    await logger.flush()

    expect(readLines(logFile)).toEqual(['first line', 'second { nested: true }'])

    removeTestTmpDir(tmpDir)
  })

  it('appends to an existing log file without truncating it', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'relay.log')
    fs.writeFileSync(logFile, 'line from previous run\n')
    const logger = createFileLogger({ logFilePath: logFile })

    await logger.log('line from this run')
    await logger.flush()

    expect(readLines(logFile)).toEqual(['line from previous run', 'line from this run'])

    removeTestTmpDir(tmpDir)
  })

  it('rotates by byte budget and keeps the newest lines', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'relay.log')
    const logger = createFileLogger({ logFilePath: logFile, maxFileBytes: 150 })

    // 29 chars + newline = 30 bytes per line, 3 lines per flush = 90 bytes.
    const makeLine = (i: number) => {
      return `line-${String(i).padStart(3, '0')}-${'x'.repeat(20)}`
    }

    for (let flush = 0; flush < 4; flush++) {
      for (let i = 0; i < 3; i++) {
        await logger.log(makeLine(flush * 3 + i))
      }
      await logger.flush()
    }

    const ids = readLines(logFile).map((line) => {
      return line.split('-')[1]
    })
    expect(ids).toMatchInlineSnapshot(`
      [
        "010",
        "011",
      ]
    `)

    removeTestTmpDir(tmpDir)
  })

  it('drops oldest buffered lines when the buffer cap is exceeded', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'relay.log')
    const logger = createFileLogger({ logFilePath: logFile, maxBufferedLines: 5 })

    for (let i = 0; i < 8; i++) {
      await logger.log(`line-${i}`)
    }
    await logger.flush()

    expect(readLines(logFile)).toMatchInlineSnapshot(`
      [
        "[log buffer overflow: dropped 3 lines]",
        "line-3",
        "line-4",
        "line-5",
        "line-6",
        "line-7",
      ]
    `)

    removeTestTmpDir(tmpDir)
  })

  it('disables itself without throwing when the log path cannot be written', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'used-as-dir')
    fs.mkdirSync(logFile)
    const logger = createFileLogger({ logFilePath: logFile })

    await expect(logger.log('into the void')).resolves.toBeUndefined()
    await expect(logger.flush()).resolves.toBeUndefined()

    expect(fs.readdirSync(logFile)).toEqual([])

    removeTestTmpDir(tmpDir)
  })

  it('keeps logging after an append failure without rejecting the queue', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'relay.log')
    const logger = createFileLogger({ logFilePath: logFile })

    await logger.log('before failure')
    await logger.flush()
    expect(readLines(logFile)).toEqual(['before failure'])

    // Replace the file with a directory so every append fails with EISDIR.
    fs.rmSync(logFile)
    fs.mkdirSync(logFile)

    await logger.log('during failure')
    await expect(logger.flush()).resolves.toBeUndefined()
    await logger.log('still alive')
    await expect(logger.flush()).resolves.toBeUndefined()

    removeTestTmpDir(tmpDir)
  })
})
