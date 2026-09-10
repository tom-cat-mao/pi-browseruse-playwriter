import fs from 'node:fs'
import path from 'node:path'
import { LOG_CDP_FILE_PATH } from './utils.js'

export type CdpLogEntry = {
  timestamp: string
  direction: 'from-playwright' | 'to-playwright' | 'from-extension' | 'to-extension'
  clientId?: string
  source?: 'extension' | 'server'
  message: unknown
}

export type CdpLogger = {
  log(entry: CdpLogEntry): void
  /** Wait for all pending writes (and any in-flight rotation) to complete */
  flush(): Promise<void>
  logFilePath: string
}

const DEFAULT_MAX_STRING_LENGTH = Number(process.env.PLAYWRITER_CDP_LOG_MAX_STRING_LENGTH || 2000)

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  const truncatedCount = value.length - maxLength
  return `${value.slice(0, maxLength)}…[truncated ${truncatedCount} chars]`
}

function createTruncatingReplacer({ maxStringLength }: { maxStringLength: number }) {
  const seen = new WeakSet<object>()
  return (_key: string, value: unknown) => {
    if (typeof value === 'string') {
      return truncateString(value, maxStringLength)
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  }
}

const DEFAULT_MAX_ENTRIES = 10_000
const FLUSH_INTERVAL_MS = 500
// Cap the in-memory buffer so a stalled disk cannot grow it without bound.
// When exceeded we drop the oldest lines and record how many were dropped.
const DEFAULT_MAX_BUFFERED_LINES = 20_000

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 2) {
    return fallback
  }
  return Math.floor(value)
}

type CdpLoggerOptions = {
  logFilePath?: string
  maxStringLength?: number
  maxEntries?: number
  maxBufferedLines?: number
}

/**
 * JSONL logger for raw CDP traffic. Like the relay file logger this is
 * best-effort: append/rotation failures are swallowed so a broken or full disk
 * cannot poison the write queue or crash the relay, and the in-memory buffer
 * is bounded. Kept file grows to at most `maxEntries` lines before rotating to
 * the most recent half.
 */
export function createCdpLogger({
  logFilePath,
  maxStringLength,
  maxEntries,
  maxBufferedLines,
}: CdpLoggerOptions = {}): CdpLogger {
  const resolvedLogFilePath = logFilePath || LOG_CDP_FILE_PATH
  const resolvedMaxEntries = resolvePositiveInt(
    maxEntries,
    resolvePositiveInt(Number(process.env.PLAYWRITER_CDP_LOG_MAX_ENTRIES), DEFAULT_MAX_ENTRIES),
  )
  const resolvedMaxBufferedLines = resolvePositiveInt(
    maxBufferedLines,
    resolvePositiveInt(Number(process.env.PLAYWRITER_CDP_LOG_MAX_BUFFERED_LINES), DEFAULT_MAX_BUFFERED_LINES),
  )
  const maxLength = maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
  // Keep half the entries after rotation so we don't rotate on every write
  const keepAfterRotation = Math.floor(resolvedMaxEntries / 2)

  const enabled = (() => {
    try {
      const logDir = path.dirname(resolvedLogFilePath)
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
      }
      fs.writeFileSync(resolvedLogFilePath, '')
      return true
    } catch {
      return false
    }
  })()

  let queue: Promise<void> = Promise.resolve()
  let lineCount = 0
  let droppedLines = 0
  let buffer: string[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    queue = queue.then(operation, operation)
    return queue
  }

  // Atomic rotation: write to temp file then rename to avoid corruption on crash
  const rotate = async (): Promise<void> => {
    try {
      const content = await fs.promises.readFile(resolvedLogFilePath, 'utf-8')
      const lines = content.split('\n').filter((line) => {
        return line.length > 0
      })
      const kept = lines.slice(-keepAfterRotation)
      const tmpPath = `${resolvedLogFilePath}.tmp`
      await fs.promises.writeFile(tmpPath, kept.join('\n') + '\n')
      await fs.promises.rename(tmpPath, resolvedLogFilePath)
      lineCount = kept.length
    } catch {
      // If rotation fails (disk error, permissions), keep logging without rotation.
      // lineCount stays high so rotation will be retried on next write.
    }
  }

  const flushBuffer = async (): Promise<void> => {
    if (!enabled || buffer.length === 0) {
      buffer = []
      return
    }
    const lines = buffer
    buffer = []
    if (droppedLines > 0) {
      const marker: CdpLogEntry = {
        timestamp: new Date().toISOString(),
        direction: 'from-extension',
        source: 'server',
        message: { method: 'cdpLogOverflow', droppedLines },
      }
      lines.unshift(JSON.stringify(marker))
      droppedLines = 0
    }
    try {
      await fs.promises.appendFile(resolvedLogFilePath, lines.join('\n') + '\n')
      lineCount += lines.length
      if (lineCount > resolvedMaxEntries) {
        await rotate()
      }
    } catch {
      // Never reject the queue: logging failures must not escape into the relay.
    }
  }

  const log = (entry: CdpLogEntry): void => {
    if (!enabled) {
      return
    }
    const replacer = createTruncatingReplacer({ maxStringLength: maxLength })
    const line = JSON.stringify(entry, replacer)
    buffer.push(line)
    if (buffer.length > resolvedMaxBufferedLines) {
      const overflow = buffer.length - resolvedMaxBufferedLines
      buffer = buffer.slice(overflow)
      droppedLines += overflow
    }
    if (!flushTimer) {
      flushTimer = setInterval(() => {
        void enqueue(flushBuffer)
      }, FLUSH_INTERVAL_MS)
      flushTimer.unref()
    }
  }

  const flush = async (): Promise<void> => {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = undefined
    }
    await enqueue(flushBuffer)
  }

  return {
    log,
    flush,
    logFilePath: resolvedLogFilePath,
  }
}
