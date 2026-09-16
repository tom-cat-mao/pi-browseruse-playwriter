/**
 * First-class artifact store for bytes produced by browser operations.
 *
 * Bytes never reach the model: a browser (or a runtime-side producer) hands the
 * payload to the store, the store writes it under the runtime data directory and
 * returns a BrowserArtifact descriptor. Every write is confined to the artifacts
 * root, so a page-derived label can name a file but can never steer a write
 * outside that directory.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ScopedFS } from './scoped-fs.js'
import { resolveBrowserRuntimeConfig } from './utils.js'
import type { BrowserArtifact } from './browser-protocol.js'

/** Largest single artifact the store accepts. */
export const ARTIFACT_FILE_LIMIT_BYTES = 16 * 1024 * 1024
/** Largest artifact total the store accepts per session before rejecting further writes. */
export const ARTIFACT_SESSION_LIMIT_BYTES = 64 * 1024 * 1024
/** Directory under the runtime data directory that owns every stored artifact. */
const ARTIFACTS_DIR_NAME = 'artifacts'

/** Session accounting is bounded so a long-lived runtime cannot grow it forever. */
const MAX_TRACKED_SESSIONS = 1024
const FILE_NAME_SLUG_MAX_LENGTH = 48
const DEFAULT_FILE_NAME_SLUG = 'artifact'
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * mime type -> file extension for the artifact kinds the store can name.
 * Unknown mime types are rejected instead of being written with a guessed extension.
 */
const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'text/markdown': '.md',
  'text/html': '.html',
}

export type ArtifactStoreErrorCode = 'invalid-request'

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode

  constructor({ code, message }: { code: ArtifactStoreErrorCode; message: string }) {
    super(message)
    this.name = 'ArtifactStoreError'
    this.code = code
  }
}

export type WriteArtifactOptions = {
  /** Base64 payload exactly as it arrived from a browser. */
  base64?: string
  /** Already decoded payload, for runtime-side producers. */
  buffer?: Buffer
  mimeType: string
  /** Human-readable label; also names the file after being sanitized. */
  label?: string
  sourceUrl?: string
  sessionId?: string
  /**
   * Exact file for the artifact, when the caller asked for one. Still confined
   * to the artifacts root: a caller-picked path is honored inside it and
   * rejected outside it, exactly like a generated name.
   */
  targetPath?: string
}

function createEscapeError(candidatePath: string): ArtifactStoreError {
  return new ArtifactStoreError({
    code: 'invalid-request',
    message: `artifact path escapes the artifacts directory: ${candidatePath}`,
  })
}

function createMalformedPayloadError(): ArtifactStoreError {
  return new ArtifactStoreError({ code: 'invalid-request', message: 'artifact base64 payload is malformed' })
}

function createFileTooLargeError(bytes: number): ArtifactStoreError {
  return new ArtifactStoreError({
    code: 'invalid-request',
    message: `artifact of ${bytes} bytes exceeds the ${ARTIFACT_FILE_LIMIT_BYTES} byte per-file limit`,
  })
}

function isWithinDirectory({ directory, candidate }: { directory: string; candidate: string }): boolean {
  return candidate === directory || candidate.startsWith(directory + path.sep)
}

/**
 * Confine a resolved artifact path to the artifacts root. Both sides are
 * realpath-resolved, so a symlinked root stays usable while a symlinked file
 * inside it cannot redirect the write outside the root.
 */
export function assertArtifactPathWithinRoot({
  rootDir,
  candidatePath,
}: {
  rootDir: string
  candidatePath: string
}): void {
  const rootReal = fs.realpathSync(rootDir)
  const parentReal = fs.realpathSync(path.dirname(candidatePath))
  if (!isWithinDirectory({ directory: rootReal, candidate: parentReal })) {
    throw createEscapeError(candidatePath)
  }
  const existing = fs.lstatSync(candidatePath, { throwIfNoEntry: false })
  if (!existing?.isSymbolicLink()) {
    return
  }
  let targetReal = ''
  try {
    targetReal = fs.realpathSync(candidatePath)
  } catch {
    throw createEscapeError(candidatePath)
  }
  if (!isWithinDirectory({ directory: rootReal, candidate: targetReal })) {
    throw createEscapeError(candidatePath)
  }
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase()
}

/**
 * Decoded size computed from the base64 length, so an oversized payload is
 * rejected before decoding allocates a copy of it. Exactly the size for well
 * formed base64; a length that is not a multiple of four is malformed and gets
 * the upper-bound estimate, which is enough to reject it early too.
 */
function estimateDecodedBytes(base64: string): number {
  if (base64.length % 4 !== 0) {
    return Math.ceil(base64.length / 4) * 3
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

function decodeArtifactBytes({ base64, buffer }: Pick<WriteArtifactOptions, 'base64' | 'buffer'>): Buffer {
  if (buffer !== undefined && base64 === undefined) {
    return buffer
  }
  if (base64 === undefined || buffer !== undefined) {
    throw new ArtifactStoreError({
      code: 'invalid-request',
      message: 'artifact requires exactly one of a base64 or a Buffer payload',
    })
  }
  const estimatedBytes = estimateDecodedBytes(base64)
  if (estimatedBytes > ARTIFACT_FILE_LIMIT_BYTES) {
    throw createFileTooLargeError(estimatedBytes)
  }
  const decoded = Buffer.from(base64, 'base64')
  if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64) || decoded.toString('base64') !== base64) {
    throw createMalformedPayloadError()
  }
  return decoded
}

function createLabelSlug(label: string | undefined): string {
  const slug = (label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FILE_NAME_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '')
  return slug || DEFAULT_FILE_NAME_SLUG
}

/** Timestamp + random suffix keeps concurrent writers from overwriting each other. */
function createArtifactFileName({ label, extension }: { label?: string; extension: string }): string {
  return `${createLabelSlug(label)}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${extension}`
}

export class ArtifactStore {
  private readonly rootDir: string
  private readonly scopedFs: ScopedFS
  private readonly sessionBytes = new Map<string, number>()

  constructor({ rootDir }: { rootDir?: string } = {}) {
    this.rootDir = path.resolve(rootDir ?? path.join(resolveBrowserRuntimeConfig().dataDir, ARTIFACTS_DIR_NAME))
    this.scopedFs = new ScopedFS([this.rootDir], this.rootDir)
  }

  getRootDir(): string {
    return this.rootDir
  }

  write(options: WriteArtifactOptions): BrowserArtifact {
    const mimeType = normalizeMimeType(options.mimeType)
    const extension = MIME_TYPE_EXTENSIONS[mimeType]
    if (!extension) {
      throw new ArtifactStoreError({
        code: 'invalid-request',
        message: `unsupported artifact mimeType ${options.mimeType}`,
      })
    }
    const buffer = decodeArtifactBytes(options)
    if (buffer.length > ARTIFACT_FILE_LIMIT_BYTES) {
      throw createFileTooLargeError(buffer.length)
    }
    const sessionId = options.sessionId ?? ''
    const sessionTotal = (this.sessionBytes.get(sessionId) ?? 0) + buffer.length
    if (sessionTotal > ARTIFACT_SESSION_LIMIT_BYTES) {
      throw new ArtifactStoreError({
        code: 'invalid-request',
        message: `session artifacts would reach ${sessionTotal} bytes and exceed the ${ARTIFACT_SESSION_LIMIT_BYTES} byte session limit`,
      })
    }
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 })
    const outputPath = options.targetPath === undefined
      ? path.join(this.rootDir, createArtifactFileName({ label: options.label, extension }))
      : this.resolveTargetPath(options.targetPath)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 })
    assertArtifactPathWithinRoot({ rootDir: this.rootDir, candidatePath: outputPath })
    this.scopedFs.writeFileSync(outputPath, buffer, { mode: 0o600 })
    this.trackSessionBytes({ sessionId, total: sessionTotal })
    return {
      path: outputPath,
      mimeType,
      bytes: buffer.length,
      ...(options.label ? { label: options.label } : {}),
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    }
  }

  /**
   * A caller-picked path is checked lexically before any directory is created,
   * so a target outside the root can never make the store create directories
   * outside it; the symlink-safe check runs again after the parent exists.
   */
  private resolveTargetPath(targetPath: string): string {
    const resolved = path.resolve(targetPath)
    if (!isWithinDirectory({ directory: this.rootDir, candidate: resolved })) {
      throw createEscapeError(resolved)
    }
    return resolved
  }

  private trackSessionBytes({ sessionId, total }: { sessionId: string; total: number }): void {
    this.sessionBytes.set(sessionId, total)
    while (this.sessionBytes.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessionBytes.keys().next().value
      if (oldest === undefined) {
        return
      }
      this.sessionBytes.delete(oldest)
    }
  }
}
