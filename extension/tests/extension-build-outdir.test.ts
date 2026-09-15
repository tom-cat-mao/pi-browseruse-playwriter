import { describe, expect, test } from 'vitest'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')
const realExtensionDir = path.join(repoRoot, 'extension')
const guardMessage = 'PLAYWRITER_EXTENSION_DIST must be dist or a Chrome dist-<suffix> directory'
const sourceDirs = ['src', 'scripts', 'tests', 'test-fixtures', 'icons']

function extensionFixture() {
  const tempRoot = path.join(repoRoot, 'tmp')
  fs.mkdirSync(tempRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(tempRoot, 'extension-outdir-'))
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(
    path.join(realExtensionDir, 'scripts/build-extension.mjs'),
    path.join(root, 'scripts/build-extension.mjs'),
  )
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'extension-outdir-fixture', private: true }))
  for (const sourceDir of sourceDirs) {
    fs.mkdirSync(path.join(root, sourceDir), { recursive: true })
    fs.writeFileSync(path.join(root, sourceDir, 'keep.txt'), 'keep')
  }
  return root
}

function runFixtureBuild({ root, outDirName }: { root: string; outDirName?: string }) {
  const env = { ...process.env }
  if (outDirName === undefined) {
    delete env.PLAYWRITER_EXTENSION_DIST
  } else {
    env.PLAYWRITER_EXTENSION_DIST = outDirName
  }
  return childProcess.spawnSync(process.execPath, ['scripts/build-extension.mjs', '--fork'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env,
  })
}

function expectFixtureSourcesIntact(root: string) {
  for (const sourceDir of sourceDirs) {
    expect(fs.existsSync(path.join(root, sourceDir, 'keep.txt'))).toBe(true)
  }
}

describe('extension build output directory', () => {
  test.each([
    'src',
    'scripts',
    'tests',
    'test-fixtures',
    'icons',
    '.',
    '..',
    '../src',
    'dist/../src',
    'src/dist',
    '/absolute',
    'dist/nested',
    'dist-firefox',
    'dist-firefox-1',
    'DIST',
    'dist-',
    'dist-../src',
  ])('refuses PLAYWRITER_EXTENSION_DIST=%j and deletes nothing', (outDirName) => {
    const root = extensionFixture()
    try {
      const result = runFixtureBuild({ root, outDirName })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(guardMessage)
      expectFixtureSourcesIntact(root)
      expect(fs.existsSync(path.join(realExtensionDir, 'src/tutorial.html'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('clears an allowed Chrome output directory and leaves sources alone', () => {
    const root = extensionFixture()
    try {
      const outDir = path.join(root, 'dist-fixture')
      fs.mkdirSync(outDir)
      fs.writeFileSync(path.join(outDir, 'stale-page.html'), 'stale')
      const result = runFixtureBuild({ root, outDirName: 'dist-fixture' })
      expect(result.stderr).not.toContain(guardMessage)
      expect(fs.existsSync(outDir)).toBe(false)
      expectFixtureSourcesIntact(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('clears only the link when the allowed output directory is a symlink', () => {
    const root = extensionFixture()
    const target = path.join(path.dirname(root), `${path.basename(root)}-target`)
    try {
      fs.mkdirSync(path.join(target, 'inner'), { recursive: true })
      fs.writeFileSync(path.join(target, 'inner/keep.txt'), 'keep')
      const link = path.join(root, 'dist-link')
      fs.symlinkSync(target, link, 'dir')
      const result = runFixtureBuild({ root, outDirName: 'dist-link' })
      expect(result.stderr).not.toContain(guardMessage)
      expect(fs.existsSync(link)).toBe(false)
      expect(fs.existsSync(path.join(target, 'inner/keep.txt'))).toBe(true)
      expectFixtureSourcesIntact(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  test('treats an unset or empty variable as the default dist directory', () => {
    const root = extensionFixture()
    try {
      fs.mkdirSync(path.join(root, 'dist'))
      fs.writeFileSync(path.join(root, 'dist/stale-page.html'), 'stale')
      const unset = runFixtureBuild({ root })
      expect(unset.stderr).not.toContain(guardMessage)
      expect(fs.existsSync(path.join(root, 'dist'))).toBe(false)
      const empty = runFixtureBuild({ root, outDirName: '' })
      expect(empty.stderr).not.toContain(guardMessage)
      expectFixtureSourcesIntact(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
