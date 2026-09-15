import { describe, expect, test } from 'vitest'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { manifestEntryReferences, validateBundle } from '../../scripts/package-extension.mjs'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')
const extensionDir = path.join(repoRoot, 'extension')

function declaredHtmlPages(manifest: Record<string, unknown>): string[] {
  return manifestEntryReferences(manifest)
    .map(([, reference]) => {
      return reference
    })
    .filter((reference): reference is string => {
      return typeof reference === 'string' && reference.endsWith('.html')
    })
    .map((reference) => {
      return path.posix.normalize(reference)
    })
}

function readManifest(fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(extensionDir, fileName), 'utf8'))
}

function firefoxPackageFixture() {
  const tempRoot = path.join(repoRoot, 'tmp')
  fs.mkdirSync(tempRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(tempRoot, 'extension-package-'))
  const manifest = readManifest('manifest.firefox.json')
  const bundle = path.join(root, 'playwriter/dist/extension-firefox')
  fs.mkdirSync(bundle, { recursive: true })
  fs.mkdirSync(path.join(root, 'extension'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'))
  for (const script of ['package-extension.mjs', 'firefox-csp.mjs']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', script), path.join(root, 'scripts', script))
  }
  fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, 'extension/manifest.json'), JSON.stringify(manifest))
  fs.cpSync(path.join(extensionDir, 'icons'), path.join(bundle, 'icons'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'firefox-build.json'), JSON.stringify({ host: '127.0.0.1', port: 19989 }))
  fs.writeFileSync(path.join(bundle, 'firefox-background.js'), 'const PORT = 19989;')
  fs.writeFileSync(path.join(bundle, 'firefox-dom.js'), '')
  fs.writeFileSync(path.join(bundle, 'firefox-popup.js'), '')
  return { root, bundle, manifest }
}

function copyDeclaredPages({ bundle, manifest }: { bundle: string; manifest: Record<string, unknown> }): string[] {
  const pages = declaredHtmlPages(manifest)
  for (const page of pages) {
    const target = path.join(bundle, ...page.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(extensionDir, 'src', path.basename(page)), target)
  }
  fs.copyFileSync(path.join(extensionDir, 'src/firefox-tutorial.css'), path.join(bundle, 'firefox-tutorial.css'))
  fs.writeFileSync(path.join(bundle, 'firefox-tutorial.js'), '')
  return pages
}

function runPackageExtension(root: string): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(process.execPath, ['scripts/package-extension.mjs', '--firefox'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  })
}

describe('extension package local entry points', () => {
  test('collects every local manifest entry point with its manifest field', () => {
    expect(
      manifestEntryReferences({
        background: { service_worker: 'background.js', scripts: ['a.js', 'b.js'] },
        action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon-16.png' } },
        options_ui: { page: 'src/tutorial.html', open_in_tab: true },
        options_page: 'legacy-options.html',
        icons: { 128: 'icons/icon-128.png' },
      }),
    ).toEqual([
      ['background.service_worker', 'background.js'],
      ['background.scripts[0]', 'a.js'],
      ['background.scripts[1]', 'b.js'],
      ['action.default_popup', 'popup.html'],
      ['options_ui.page', 'src/tutorial.html'],
      ['options_page', 'legacy-options.html'],
      ['icons.128', 'icons/icon-128.png'],
      ['action.default_icon.16', 'icons/icon-16.png'],
    ])
  })

  test.each(['manifest.json', 'manifest.firefox.json'])(
    '%s only declares page entries that exist as real source pages',
    (fileName) => {
      const pages = declaredHtmlPages(readManifest(fileName))
      if (fileName === 'manifest.firefox.json') {
        expect(pages).toContain('firefox-popup.html')
      }
      for (const page of pages) {
        expect(fs.existsSync(path.join(extensionDir, 'src', path.basename(page)))).toBe(true)
      }
    },
  )

  test('packages a bundle whose manifest entry pages are all inside the ZIP', () => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      const pages = copyDeclaredPages({ bundle, manifest })
      const validation = validateBundle({ bundleDir: bundle, firefox: true })
      for (const page of pages) {
        expect(validation.files).toContain(page)
      }
      const result = runPackageExtension(root)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      const zipPath = path.join(
        root,
        'dist-release',
        `pi-browser-use-firefox-extension-${String(manifest.version)}.zip`,
      )
      expect(fs.existsSync(zipPath)).toBe(true)
      expect(fs.readFileSync(zipPath).includes(Buffer.from('firefox-popup.html'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a bundle whose manifest entry page is not packaged', () => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      copyDeclaredPages({ bundle, manifest })
      const missingPage = 'firefox-tutorial.html'
      fs.rmSync(path.join(bundle, missingPage))
      expect(fs.existsSync(path.join(bundle, missingPage))).toBe(false)
      expect(() => {
        validateBundle({ bundleDir: bundle, firefox: true })
      }).toThrow(`manifest.json options_ui.page references missing packaged file ${missingPage}`)
      const result = runPackageExtension(root)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`manifest.json options_ui.page references missing packaged file ${missingPage}`)
      expect(fs.existsSync(path.join(root, 'dist-release'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    ['a remote page', 'https://example.com/remote.html', 'options_ui.page must be a packaged local file'],
    ['a protocol-relative page', '//example.com/remote.html', 'options_ui.page must be a packaged local file'],
    ['an empty page', '', 'options_ui.page must be a non-empty string'],
    ['a page outside the package', '../outside.html', 'options_ui.page points outside the package'],
    ['an absolute path outside the package', '/etc/hosts', 'references missing packaged file etc/hosts'],
    ['a non-string page', 42, 'options_ui.page must be a non-empty string'],
    ['an array page', ['firefox-tutorial.html'], 'options_ui.page must be a non-empty string'],
    ['a null page', null, 'options_ui.page must be a non-empty string'],
  ])('refuses an options page that is %s', (_name, page, message) => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      const withPage = { ...manifest, options_ui: { page, open_in_tab: true } }
      fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(withPage))
      copyDeclaredPages({ bundle, manifest: manifest })
      expect(() => {
        validateBundle({ bundleDir: bundle, firefox: true })
      }).toThrow(message)
      expect(fs.existsSync(path.join(root, 'dist-release'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    ['a string container', 'firefox-tutorial.html', 'manifest.json options_ui must be an object with a page'],
    ['an array container', ['firefox-tutorial.html'], 'manifest.json options_ui must be an object with a page'],
    ['a numeric container', 42, 'manifest.json options_ui must be an object with a page'],
    ['a null container', null, 'manifest.json options_ui must be an object with a page'],
    ['a container without a page', { open_in_tab: true }, 'manifest.json options_ui must declare a page'],
  ])('refuses an options_ui that is %s', (_name, optionsUi, message) => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ ...manifest, options_ui: optionsUi }))
      copyDeclaredPages({ bundle, manifest })
      expect(() => {
        validateBundle({ bundleDir: bundle, firefox: true })
      }).toThrow(message)
      const result = runPackageExtension(root)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(message)
      expect(fs.existsSync(path.join(root, 'dist-release'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a popup entry that leaves the package', () => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      const withPopup = { ...manifest, action: { ...manifest.action, default_popup: '../../popup.html' } }
      fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(withPopup))
      copyDeclaredPages({ bundle, manifest })
      expect(() => {
        validateBundle({ bundleDir: bundle, firefox: true })
      }).toThrow('manifest.json action.default_popup points outside the package: ../../popup.html')
      expect(fs.existsSync(path.join(root, 'dist-release'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a page that references an unpackaged local asset', () => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      copyDeclaredPages({ bundle, manifest })
      const popup = path.join(bundle, 'firefox-popup.html')
      const html = fs.readFileSync(path.join(extensionDir, 'src/firefox-popup.html'), 'utf8')
      expect(html).toContain('</head>')
      fs.writeFileSync(popup, html.replace('</head>', '    <link rel="stylesheet" href="tutorial.css" />\n  </head>'))
      expect(() => {
        validateBundle({ bundleDir: bundle, firefox: true })
      }).toThrow('firefox-popup.html references missing packaged file tutorial.css')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a page whose local link points at an unpackaged page', () => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      copyDeclaredPages({ bundle, manifest })
      const popup = path.join(bundle, 'firefox-popup.html')
      const html = fs.readFileSync(path.join(extensionDir, 'src/firefox-popup.html'), 'utf8')
      expect(html).toContain('href="firefox-tutorial.html"')
      fs.writeFileSync(
        popup,
        html.replace('<a class="tutorial-link" href="firefox-tutorial.html"', '<a class="tutorial-link" href="missing-page.html"'),
      )
      expect(() => {
        validateBundle({ bundleDir: bundle, firefox: true })
      }).toThrow('firefox-popup.html references missing packaged file missing-page.html')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('accepts a page whose cross-page links are explicit external URLs or fragments', () => {
    const { root, bundle, manifest } = firefoxPackageFixture()
    try {
      copyDeclaredPages({ bundle, manifest })
      const popup = path.join(bundle, 'firefox-popup.html')
      const html = fs.readFileSync(path.join(extensionDir, 'src/firefox-popup.html'), 'utf8')
      const externalAnchor =
        '<a href="https://github.com/tom-cat-mao/pi-browseruse-playwriter" target="_blank" rel="noopener noreferrer"'
      fs.writeFileSync(
        popup,
        html
          .replace('<a class="tutorial-link" href="firefox-tutorial.html"', externalAnchor)
          .replace('</body>', '    <a href="#release-status">跳到状态</a>\n  </body>'),
      )
      const validation = validateBundle({ bundleDir: bundle, firefox: true })
      expect(validation.files).toContain('firefox-popup.html')
      const result = runPackageExtension(root)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
