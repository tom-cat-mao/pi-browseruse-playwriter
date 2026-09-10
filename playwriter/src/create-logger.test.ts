import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileLogger } from './create-logger.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-logger-test-'))
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

    fs.rmSync(tmpDir, { recursive: true })
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

    fs.rmSync(tmpDir, { recursive: true })
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

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('disables itself without throwing when the log path cannot be written', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'used-as-dir')
    fs.mkdirSync(logFile)
    const logger = createFileLogger({ logFilePath: logFile })

    await expect(logger.log('into the void')).resolves.toBeUndefined()
    await expect(logger.flush()).resolves.toBeUndefined()

    expect(fs.readdirSync(logFile)).toEqual([])

    fs.rmSync(tmpDir, { recursive: true })
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

    fs.rmSync(tmpDir, { recursive: true })
  })
})
