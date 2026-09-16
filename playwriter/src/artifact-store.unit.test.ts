/**
 * Artifact store tests: real files under temporary directories, no mocks.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ARTIFACT_FILE_LIMIT_BYTES,
  ARTIFACT_SESSION_LIMIT_BYTES,
  ArtifactStore,
  ArtifactStoreError,
  assertArtifactPathWithinRoot,
} from './artifact-store.js'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7AoAAAAASUVORK5CYII='

function createTempDir(prefix: string): string {
  const tempRoot = path.join(process.cwd(), 'tmp')
  fs.mkdirSync(tempRoot, { recursive: true })
  return fs.mkdtempSync(path.join(tempRoot, prefix))
}

function captureArtifactStoreError({ run }: { run: () => void }): ArtifactStoreError {
  let captured: unknown = null
  try {
    run()
  } catch (error) {
    captured = error
  }
  expect(captured).toBeInstanceOf(ArtifactStoreError)
  if (!(captured instanceof ArtifactStoreError)) {
    throw new Error('expected an ArtifactStoreError')
  }
  return captured
}

describe('ArtifactStore writes', () => {
  test('writes base64 bytes under the artifacts root and reports the descriptor', () => {
    const directory = createTempDir('artifact-store-')
    const rootDir = path.join(directory, 'artifacts')
    try {
      const store = new ArtifactStore({ rootDir })
      const artifact = store.write({
        base64: PNG_BASE64,
        mimeType: 'image/png',
        label: 'Page Hero',
        sourceUrl: 'https://example.com/hero.png',
        sessionId: 'session-1',
      })

      expect(path.dirname(artifact.path)).toBe(rootDir)
      expect(path.basename(artifact.path)).toMatch(/^page-hero-[0-9a-z]+-[0-9a-f]{8}\.png$/)
      expect(artifact.mimeType).toBe('image/png')
      expect(artifact.bytes).toBe(Buffer.from(PNG_BASE64, 'base64').length)
      expect(artifact.label).toBe('Page Hero')
      expect(artifact.sourceUrl).toBe('https://example.com/hero.png')
      expect(fs.readFileSync(artifact.path).toString('base64')).toBe(PNG_BASE64)
      expect(fs.statSync(artifact.path).size).toBe(artifact.bytes)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('accepts a Buffer payload and normalizes the reported mime type', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const store = new ArtifactStore({ rootDir: directory })
      const buffer = Buffer.from([1, 2, 3, 4, 5])
      const artifact = store.write({ buffer, mimeType: 'IMAGE/JPEG; charset=binary' })

      expect(artifact.mimeType).toBe('image/jpeg')
      expect(artifact.bytes).toBe(buffer.length)
      expect(artifact.label).toBeUndefined()
      expect(path.basename(artifact.path)).toMatch(/^artifact-[0-9a-z]+-[0-9a-f]{8}\.jpg$/)
      expect(fs.readFileSync(artifact.path).equals(buffer)).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('maps every supported image mime type to its extension', () => {
    const directory = createTempDir('artifact-store-')
    const extensions: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
    }
    try {
      const store = new ArtifactStore({ rootDir: directory })
      for (const [mimeType, extension] of Object.entries(extensions)) {
        const artifact = store.write({ buffer: Buffer.from([9]), mimeType })
        expect(artifact.path.endsWith(extension)).toBe(true)
        expect(artifact.mimeType).toBe(mimeType)
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects an unsupported mime type instead of guessing an extension', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const store = new ArtifactStore({ rootDir: directory })
      const error = captureArtifactStoreError({
        run: () => {
          store.write({ buffer: Buffer.from([1]), mimeType: 'application/zip' })
        },
      })
      expect(error.code).toBe('invalid-request')
      expect(error.message).toContain('unsupported artifact mimeType')
      expect(fs.readdirSync(directory)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects malformed base64 payloads', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const store = new ArtifactStore({ rootDir: directory })
      for (const base64 of ['not base64!!', 'AAAA=', 'iVBOR']) {
        const error = captureArtifactStoreError({
          run: () => {
            store.write({ base64, mimeType: 'image/png' })
          },
        })
        expect(error.code).toBe('invalid-request')
        expect(error.message).toContain('base64 payload is malformed')
      }
      expect(fs.readdirSync(directory)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('requires exactly one payload', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const store = new ArtifactStore({ rootDir: directory })
      const missing = captureArtifactStoreError({
        run: () => {
          store.write({ mimeType: 'image/png' })
        },
      })
      expect(missing.code).toBe('invalid-request')
      const both = captureArtifactStoreError({
        run: () => {
          store.write({ base64: PNG_BASE64, buffer: Buffer.from([1]), mimeType: 'image/png' })
        },
      })
      expect(both.code).toBe('invalid-request')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('keeps a traversal-looking label inside the artifacts root', () => {
    const directory = createTempDir('artifact-store-')
    const rootDir = path.join(directory, 'artifacts')
    try {
      const store = new ArtifactStore({ rootDir })
      const artifact = store.write({
        buffer: Buffer.from([7]),
        mimeType: 'image/png',
        label: '../../etc/passwd',
        sessionId: 'session-1',
      })

      expect(path.dirname(artifact.path)).toBe(rootDir)
      expect(artifact.path.startsWith(rootDir + path.sep)).toBe(true)
      expect(path.basename(artifact.path)).toMatch(/^etc-passwd-[0-9a-z]+-[0-9a-f]{8}\.png$/)
      expect(fs.readdirSync(rootDir)).toEqual([path.basename(artifact.path)])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('ArtifactStore limits', () => {
  test('rejects a payload above the per-file limit', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const store = new ArtifactStore({ rootDir: directory })
      const error = captureArtifactStoreError({
        run: () => {
          store.write({ buffer: Buffer.alloc(ARTIFACT_FILE_LIMIT_BYTES + 1), mimeType: 'image/png' })
        },
      })
      expect(error.code).toBe('invalid-request')
      expect(error.message).toContain('per-file limit')
      expect(fs.readdirSync(directory)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects writes past the per-session limit and keeps other sessions writable', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const store = new ArtifactStore({ rootDir: directory })
      const chunk = Buffer.alloc(ARTIFACT_SESSION_LIMIT_BYTES / 4, 3)
      for (let index = 0; index < 4; index += 1) {
        const artifact = store.write({ buffer: chunk, mimeType: 'image/png', sessionId: 'session-1' })
        expect(artifact.bytes).toBe(chunk.length)
      }
      const error = captureArtifactStoreError({
        run: () => {
          store.write({ buffer: Buffer.from([3]), mimeType: 'image/png', sessionId: 'session-1' })
        },
      })
      expect(error.code).toBe('invalid-request')
      expect(error.message).toContain('session limit')

      const other = store.write({ buffer: Buffer.from([3]), mimeType: 'image/png', sessionId: 'session-2' })
      expect(other.path.startsWith(directory + path.sep)).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('ArtifactStore root resolution', () => {
  test('defaults to the artifacts directory under the runtime data directory', () => {
    const directory = createTempDir('artifact-store-')
    const previousDataDir = process.env.PI_BROWSER_DATA_DIR
    try {
      process.env.PI_BROWSER_DATA_DIR = directory
      const store = new ArtifactStore({})
      expect(store.getRootDir()).toBe(path.join(directory, 'artifacts'))

      const artifact = store.write({ buffer: Buffer.from([4]), mimeType: 'image/gif', label: 'chart' })
      expect(artifact.path.startsWith(path.join(directory, 'artifacts') + path.sep)).toBe(true)
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.PI_BROWSER_DATA_DIR
      } else {
        process.env.PI_BROWSER_DATA_DIR = previousDataDir
      }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('assertArtifactPathWithinRoot', () => {
  test('accepts a plain path inside the root and rejects a traversal candidate', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const rootDir = path.join(directory, 'artifacts')
      fs.mkdirSync(rootDir, { recursive: true })

      expect(() => {
        assertArtifactPathWithinRoot({ rootDir, candidatePath: path.join(rootDir, 'inside.png') })
      }).not.toThrow()

      const error = captureArtifactStoreError({
        run: () => {
          assertArtifactPathWithinRoot({ rootDir, candidatePath: path.join(rootDir, '..', 'outside.png') })
        },
      })
      expect(error.code).toBe('invalid-request')
      expect(error.message).toContain('escapes the artifacts directory')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('rejects a symlink that points outside the root', () => {
    const directory = createTempDir('artifact-store-')
    try {
      const rootDir = path.join(directory, 'artifacts')
      const outsidePath = path.join(directory, 'outside.png')
      fs.mkdirSync(rootDir, { recursive: true })
      fs.writeFileSync(outsidePath, 'outside')

      const escapingLink = path.join(rootDir, 'linked.png')
      fs.symlinkSync(outsidePath, escapingLink)
      const error = captureArtifactStoreError({
        run: () => {
          assertArtifactPathWithinRoot({ rootDir, candidatePath: escapingLink })
        },
      })
      expect(error.code).toBe('invalid-request')

      const insidePath = path.join(rootDir, 'inside.png')
      const insideLink = path.join(rootDir, 'alias.png')
      fs.writeFileSync(insidePath, 'inside')
      fs.symlinkSync(insidePath, insideLink)
      expect(() => {
        assertArtifactPathWithinRoot({ rootDir, candidatePath: insideLink })
      }).not.toThrow()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
