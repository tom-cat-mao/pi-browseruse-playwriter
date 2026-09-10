import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import stripAnsi from 'strip-ansi'
import { LOG_FILE_PATH } from './utils.js'

export type Logger = {
  log(...args: unknown[]): Promise<void>
  error(...args: unknown[]): Promise<void>
  /** Flush buffered log lines to disk (call before process.exit) */
  flush(): Promise<void>
  logFilePath: string
}

const FLUSH_INTERVAL_MS = 500
const DEFAULT_MAX_BUFFERED_LINES = 5000
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const KEEP_AFTER_ROTATION_RATIO = 0.5

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 2) {
    return fallback
  }
  return Math.floor(value)
}

type FileLoggerOptions = {
  logFilePath?: string
  maxBufferedLines?: number
  maxFileBytes?: number
}

/**
 * File logger for the relay server. Logging is best-effort observability: a
 * failing or slow log file must never poison the write queue or bring the
 * relay down, so every filesystem error is swallowed and the queue itself is
 * built from operations that never reject. The in-memory buffer is bounded,
 * dropping the oldest lines under sustained backpressure, and the file is
 * rotated in place once it grows past a byte budget.
 */
export function createFileLogger({ logFilePath, maxBufferedLines, maxFileBytes }: FileLoggerOptions = {}): Logger {
  const resolvedLogFilePath = logFilePath || LOG_FILE_PATH
  const resolvedMaxBufferedLines = resolvePositiveInt(
    maxBufferedLines,
    resolvePositiveInt(Number(process.env.PLAYWRITER_LOG_MAX_BUFFERED_LINES), DEFAULT_MAX_BUFFERED_LINES),
  )
  const resolvedMaxFileBytes = resolvePositiveInt(
    maxFileBytes,
    resolvePositiveInt(Number(process.env.PLAYWRITER_LOG_MAX_BYTES), DEFAULT_MAX_FILE_BYTES),
  )

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
  let buffer: string[] = []
  let droppedLines = 0
  let currentBytes = 0
  let flushTimer: ReturnType<typeof setInterval> | undefined

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    queue = queue.then(operation, operation)
    return queue
  }

  const rotate = async (): Promise<void> => {
    try {
      const content = await fs.promises.readFile(resolvedLogFilePath, 'utf-8')
      const lines = content.split('\n').filter((line) => {
        return line.length > 0
      })
      const budget = Math.floor(resolvedMaxFileBytes * KEEP_AFTER_ROTATION_RATIO)
      const kept: string[] = []
      let keptBytes = 0
      for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i]) + 1
        if (keptBytes + lineBytes > budget) {
          break
        }
        kept.unshift(lines[i])
        keptBytes += lineBytes
      }
      const chunk = kept.length > 0 ? kept.join('\n') + '\n' : ''
      const tmpPath = `${resolvedLogFilePath}.tmp`
      await fs.promises.writeFile(tmpPath, chunk)
      await fs.promises.rename(tmpPath, resolvedLogFilePath)
      currentBytes = keptBytes
    } catch {
      // Rotation is best-effort. On failure keep the current file and reset the
      // counter so we do not retry rotation on every single write.
      currentBytes = 0
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
      lines.unshift(`[log buffer overflow: dropped ${droppedLines} lines]`)
      droppedLines = 0
    }
    const chunk = lines.join('\n') + '\n'
    try {
      await fs.promises.appendFile(resolvedLogFilePath, chunk)
      currentBytes += Buffer.byteLength(chunk)
      if (currentBytes > resolvedMaxFileBytes) {
        await rotate()
      }
    } catch {
      // Never reject: a broken log file must not poison later writes or crash
      // the relay. The next flush simply tries again.
    }
  }

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return
    }
    flushTimer = setInterval(() => {
      void enqueue(flushBuffer)
    }, FLUSH_INTERVAL_MS)
    flushTimer.unref()
  }

  const log = (...args: unknown[]): Promise<void> => {
    const message = args
      .map((arg) =>
        typeof arg === 'string' ? arg : util.inspect(arg, { depth: null, colors: false, maxStringLength: 1000 }),
      )
      .join(' ')
    if (!enabled) {
      return Promise.resolve()
    }
    buffer.push(stripAnsi(message))
    if (buffer.length > resolvedMaxBufferedLines) {
      const overflow = buffer.length - resolvedMaxBufferedLines
      buffer = buffer.slice(overflow)
      droppedLines += overflow
    }
    scheduleFlush()
    return queue
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
    error: log,
    flush,
    logFilePath: resolvedLogFilePath,
  }
}
