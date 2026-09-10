import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createCdpLogger, type CdpLogEntry } from './cdp-log.js'
import { makeTestTmpDir, removeTestTmpDir } from './test-tmp.js'

function makeTmpDir() {
  return makeTestTmpDir('cdp-log')
}

function makeEntry(i: number): CdpLogEntry {
  return {
    timestamp: new Date().toISOString(),
    direction: 'from-extension',
    message: { method: `Test.method${i}`, id: i },
  }
}

function readIds(logFile: string): number[] {
  return fs
    .readFileSync(logFile, 'utf-8')
    .trim()
    .split('\n')
    .filter((l) => {
      return l.length > 0
    })
    .map((l) => {
      return JSON.parse(l).message.id as number
    })
}

describe('CDP log rotation', () => {
  it('rotates when lineCount exceeds maxEntries, keeping last half', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 20 })

    // Write 25 entries to trigger rotation (threshold is 20)
    for (let i = 0; i < 25; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    const ids = readIds(logFile)

    // Rotation triggers after entry 20 is written (lineCount becomes 21 > 20).
    // It keeps last 10 (entries 11-20), then entries 21-24 are appended.
    expect(ids).toMatchInlineSnapshot(`
      [
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
      ]
    `)

    removeTestTmpDir(tmpDir)
  })

  it('does not rotate when under maxEntries', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 50 })

    for (let i = 0; i < 30; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    const ids = readIds(logFile)
    expect(ids.length).toBe(30)
    expect(ids[0]).toBe(0)
    expect(ids[29]).toBe(29)

    removeTestTmpDir(tmpDir)
  })

  it('handles multiple rotations', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 10 })

    // Write 35 entries, should trigger multiple rotations
    for (let i = 0; i < 35; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    const ids = readIds(logFile)

    // File should never exceed maxEntries
    expect(ids.length).toBeLessThanOrEqual(15)
    expect(ids.length).toBeGreaterThanOrEqual(5)

    // Last entry should always be the most recent
    expect(ids[ids.length - 1]).toBe(34)
    // No entries from the very beginning should survive multiple rotations
    expect(ids[0]).toBeGreaterThan(10)

    removeTestTmpDir(tmpDir)
  })

  it('does not throw when an entry cannot be serialized', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile })

    expect(() => {
      logger.log({
        timestamp: new Date().toISOString(),
        direction: 'from-extension',
        message: { big: 10n },
      })
    }).not.toThrow()
    await expect(logger.flush()).resolves.toBeUndefined()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).toContain('cdpLogSerializeError')

    removeTestTmpDir(tmpDir)
  })

  it('rotates based on the existing file size after a restart', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const existing = Array.from({ length: 30 }, (_, i) => {
      return JSON.stringify(makeEntry(i))
    }).join('\n')
    fs.writeFileSync(logFile, `${existing}\n`)

    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 10 })
    logger.log(makeEntry(99))
    await logger.flush()

    const ids = readIds(logFile)
    expect(ids[ids.length - 1]).toBe(99)
    expect(ids.length).toBeLessThanOrEqual(10)
    expect(ids).not.toContain(0)

    removeTestTmpDir(tmpDir)
  })

  it('appends to an existing log file without truncating it', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    fs.writeFileSync(logFile, `${JSON.stringify(makeEntry(1))}\n`)
    const logger = createCdpLogger({ logFilePath: logFile })

    logger.log(makeEntry(2))
    await logger.flush()

    expect(readIds(logFile)).toEqual([1, 2])

    removeTestTmpDir(tmpDir)
  })

  it('marks dropped lines when the buffer cap is exceeded', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxBufferedLines: 5 })

    for (let i = 0; i < 8; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    const lines = fs
      .readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => {
        const parsed = JSON.parse(line)
        if (parsed.message.method === 'cdpLogOverflow') {
          return { droppedLines: parsed.message.droppedLines, source: parsed.source }
        }
        return parsed.message.id
      })
    expect(lines).toMatchInlineSnapshot(`
      [
        {
          "droppedLines": 3,
          "source": "server",
        },
        3,
        4,
        5,
        6,
        7,
      ]
    `)

    removeTestTmpDir(tmpDir)
  })

  it('disables itself without throwing when the log path cannot be written', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'used-as-dir')
    fs.mkdirSync(logFile)
    const logger = createCdpLogger({ logFilePath: logFile })

    expect(() => {
      logger.log(makeEntry(1))
    }).not.toThrow()
    await expect(logger.flush()).resolves.toBeUndefined()

    expect(fs.readdirSync(logFile)).toEqual([])

    removeTestTmpDir(tmpDir)
  })

  it('keeps logging after an append failure without rejecting the queue', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile })

    logger.log(makeEntry(1))
    await logger.flush()
    expect(readIds(logFile)).toEqual([1])

    // Replace the file with a directory so every append fails with EISDIR.
    fs.rmSync(logFile)
    fs.mkdirSync(logFile)

    logger.log(makeEntry(2))
    await expect(logger.flush()).resolves.toBeUndefined()
    logger.log(makeEntry(3))
    await expect(logger.flush()).resolves.toBeUndefined()

    removeTestTmpDir(tmpDir)
  })

  it('uses atomic rename for rotation', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 10 })

    for (let i = 0; i < 15; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    // Temp file should not remain after successful rotation
    expect(fs.existsSync(`${logFile}.tmp`)).toBe(false)

    const ids = readIds(logFile)
    expect(ids[ids.length - 1]).toBe(14)

    removeTestTmpDir(tmpDir)
  })
})
