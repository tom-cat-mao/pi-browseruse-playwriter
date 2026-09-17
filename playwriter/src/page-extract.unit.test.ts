import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PageExtractError, extractPageContent, windowExtractedText, EXTRACT_MAX_CHARS } from './page-extract.js'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures')

const readFixture = (name: string): string => {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8')
}

const ARTICLE_URL = 'https://coastal.example/news/tidal-bores'
const DOCS_URL = 'https://storage.example/docs/retention'
const FORUM_URL = 'https://forum.example/t/build-times'
const RELEASE_URL = 'https://runtime.example/releases/0.9'
const MEDIAWIKI_URL = 'https://wiki.example/wiki/Tidal_bore'

/**
 * Parsoid output as MediaWiki serves it: each thumb is a `figure` whose `img`
 * carries `resource` (an RDFa pointer at the file description page) next to a
 * protocol-relative `src` and a density-descriptor `srcset`.
 */
const MEDIAWIKI_ARTICLE_HTML = [
  '<!doctype html><html class="client-nojs" lang="en" dir="ltr">',
  '<head><title>Tidal bore - Wikipedia</title></head><body>',
  '<div id="mw-content-text"><div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">',
  '<p>A <b>tidal bore</b> is a shallow-water wave that propagates up a river or narrow bay against the direction of the current. The bore forms where the incoming tide is funnelled into a narrowing channel and the tidal range is large relative to the depth of the estuary. Bores are documented in more than eighty estuaries worldwide, and the largest of them travel tens of kilometres inland before they dissipate.</p>',
  '<figure typeof="mw:File/Thumb" class="mw-halign-right"><a href="/wiki/File:Tidal_bore_Qiantang.jpg" class="mw-file-description"><img resource="https://wiki.example/wiki/File:Tidal_bore_Qiantang.jpg" src="//upload.example/commons/thumb/8/8a/Tidal_bore_Qiantang.jpg/250px-Tidal_bore_Qiantang.jpg" decoding="async" width="250" height="167" class="mw-file-element" srcset="//upload.example/commons/thumb/8/8a/Tidal_bore_Qiantang.jpg/500px-Tidal_bore_Qiantang.jpg 2x" data-file-width="2000" data-file-height="1333" loading="lazy"></a><figcaption>The Qiantang River bore sweeping past the seawall at Hangzhou</figcaption></figure>',
  '<p>The shape of a bore depends on the ratio of tidal amplitude to channel depth. When that ratio is small the wave steepens gradually and the front stays smooth; when it is large the front curls forward and the bore breaks, entraining air and suspending sediment from the bed. The transition between the two regimes can often be seen within a single tidal cycle as the flood tide gains strength.</p>',
  '<p>Sediment transport in a bore is concentrated in the minutes around the passage of the front. Instruments anchored in the channel record a sharp spike in suspended-sediment concentration followed by a slower decay that lasts for the rest of the flood. The net effect over a spring-neap cycle is an upstream migration of sand that keeps many navigation channels shallow.</p>',
  '<h2>Notable bores</h2>',
  '<p>The Qiantang River bore in China is the largest in the world, with a front that can exceed nine metres during the autumn spring tides. The Severn bore in England and the Pororoca on the Amazon are also well documented. Smaller bores occur on the Petitcodiac in Canada and on several rivers draining into the Bay of Fundy.</p>',
  '<figure typeof="mw:File/Thumb" class="mw-halign-left"><a href="/wiki/File:Severn_bore_surfer.jpg" class="mw-file-description"><img resource="https://wiki.example/wiki/File:Severn_bore_surfer.jpg" src="//upload.example/commons/thumb/1/1c/Severn_bore_surfer.jpg/220px-Severn_bore_surfer.jpg" decoding="async" width="220" height="147" class="mw-file-element" srcset="//upload.example/commons/thumb/1/1c/Severn_bore_surfer.jpg/440px-Severn_bore_surfer.jpg 2x" data-file-width="1600" data-file-height="1067" loading="lazy"></a><figcaption>A surfer riding the Severn bore near Newnham on Severn</figcaption></figure>',
  '<p>Recreational surfing on bores has grown since the 1950s, and several rivers now publish tide tables aimed at surfers rather than navigators. The rides are short by ocean standards but the waves are unusually predictable, which makes them attractive for record attempts and for training.</p>',
  '<p>Modelling a bore requires a depth-averaged solver that can represent a moving discontinuity in the free surface. Early one-dimensional models reproduced the timing of the front but not its height; modern two-dimensional models resolve the transverse structure of the wave and the secondary currents it drives along the banks. Field campaigns remain essential because the bed roughness of a muddy estuary is difficult to parameterise from first principles.</p>',
  '</div></div></body></html>',
].join('\n')

describe('extractPageContent markdown extraction', () => {
  it('extracts a typical article without navigation or promo blocks', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'markdown',
    })

    expect(result.title).toBe('How Tidal Bores Reshape Estuaries')
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('A tidal bore is the leading edge of an incoming tide')
    expect(result.text).toContain('### Measuring the front')
    expect(result.text).toContain('third-generation bore model')
    expect(result.text).not.toContain('Join 42,000 readers')
    expect(result.text).not.toContain('Harbour dredging budget doubles')
    expect(result.text).not.toContain('All rights reserved')
    expect(result.text).toMatchSnapshot()
  })

  it('keeps data tables as markdown pipe tables', async () => {
    const result = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
    })

    expect(result.title).toBe('Retention policy reference | Storage Docs')
    expect(result.text).toContain('| Tier | Minimum lock | Maximum lock | Object size limit | Early delete fee |')
    expect(result.text).toContain('| `compliance` | 90 days | 10 years | 5 TiB | prorated storage |')
    expect(result.text).not.toContain('Getting started')
    expect(result.text).toMatchSnapshot()
  })

  it('falls back to body scoped extraction when the automatic pass drops replies', async () => {
    const result = await extractPageContent({
      html: readFixture('forum-noisy.html'),
      url: FORUM_URL,
      format: 'markdown',
    })

    expect(result.title).toBe('Build times doubled after 0.9 upgrade')
    expect(result.text).toContain('parallelism = "auto"')
    expect(result.text).toContain('That was it. Confirmed: 13 minutes')
    expect(result.text).not.toContain('Build faster with AcmeCI')
    expect(result.text).not.toContain('Top contributors')
    expect(result.text).not.toContain('Related threads')
    expect(result.text).toMatchSnapshot()
  })

  it('reports author, site, published time and excerpt metadata', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'markdown',
    })

    expect(result.metadata?.author).toBe('Dana Whitfield')
    expect(result.metadata?.siteName).toBe('Coastal Review')
    expect(result.metadata?.publishedTime).toBe('2024-11-02T08:30:00Z')
    expect(result.metadata?.excerpt).toContain('Tidal bores look like a single wave')
  })

  it('reports site metadata inferred from the page when present', async () => {
    const result = await extractPageContent({
      html: readFixture('forum-noisy.html'),
      url: FORUM_URL,
      format: 'markdown',
    })

    expect(result.metadata?.siteName).toBe('Forum')
    expect(result.metadata?.author).toBeUndefined()
  })

  it('rewrites relative links against the provided url', async () => {
    const result = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
    })

    expect(result.text).toContain('(https://storage.example/docs/retention#migration)')
    expect(result.text).not.toContain('](/docs/retention#migration)')
  })
})

describe('extractPageContent MediaWiki images', () => {
  it('resolves figure images to the file bytes instead of the description page', async () => {
    const result = await extractPageContent({
      html: MEDIAWIKI_ARTICLE_HTML,
      url: MEDIAWIKI_URL,
      format: 'markdown',
    })

    expect(result.text).toContain(
      '![](https://upload.example/commons/thumb/8/8a/Tidal_bore_Qiantang.jpg/250px-Tidal_bore_Qiantang.jpg)',
    )
    expect(result.text).toContain(
      '![](https://upload.example/commons/thumb/1/1c/Severn_bore_surfer.jpg/220px-Severn_bore_surfer.jpg)',
    )
    expect(result.text).not.toMatch(/!\[[^\]]*\]\([^)]*\/File:/)
    expect(result.text).toContain('## Notable bores')
    expect(result.text).toMatchSnapshot()
  })

  it('keeps the resource attribute in the html format', async () => {
    // Both backends serve `format: 'html'` straight from the serialized page,
    // so the pipeline's Markdown normalization must not reach it.
    const html = windowExtractedText({ text: MEDIAWIKI_ARTICLE_HTML })

    expect(html.truncated).toBe(false)
    expect(html.text).toContain('resource="https://wiki.example/wiki/File:Tidal_bore_Qiantang.jpg"')
    expect(html.text).toBe(MEDIAWIKI_ARTICLE_HTML)
  })
})

describe('extractPageContent element fragments', () => {
  it('extracts a bare div fragment instead of scoring its body as boilerplate', async () => {
    const result = await extractPageContent({
      html: readFixture('fragment-div.html'),
      url: DOCS_URL,
      format: 'markdown',
    })

    expect(result.title).toBeUndefined()
    expect(result.truncated).toBe(false)
    expect(result.text.startsWith('## Retention window')).toBe(true)
    expect(result.text).toContain('Every object written to a locked bucket carries a retain-until timestamp.')
    expect(result.text).toContain('- Objects larger than five tebibytes cannot enter the tier')
    expect(result.text).toContain('(https://storage.example/docs/retention#migration)')
    expect(result.text).toMatchSnapshot()
  })

  it('extracts a bare section fragment that carries no heading of its own', async () => {
    const result = await extractPageContent({
      html: readFixture('fragment-section.html'),
      url: RELEASE_URL,
      format: 'markdown',
    })

    expect(result.title).toBeUndefined()
    expect(result.truncated).toBe(false)
    expect(result.text.startsWith('Release 0.9 changed how the runtime resolves a managed profile.')).toBe(true)
    expect(result.text).toContain('`profile-disconnected`')
    expect(result.text).toContain('- Every relay log line carries the connection id and the browser epoch.')
    expect(result.text).toContain('Rollback is a single version pin.')
    expect(result.text).toMatchSnapshot()
  })

  it('still treats a doctype-only prefix as a fragment', async () => {
    const result = await extractPageContent({
      html: readFixture('fragment-div.html').replace(/^/, '  <!doctype html>\n\n'),
      url: DOCS_URL,
      format: 'markdown',
    })

    expect(result.text.startsWith('## Retention window')).toBe(true)
    expect(result.text).toContain('The window is set when the object is written')
  })

  it('titles a fragment with the title the caller already knows', async () => {
    const result = await extractPageContent({
      html: readFixture('fragment-section.html'),
      url: RELEASE_URL,
      title: 'Runtime 0.9 release notes',
      format: 'markdown',
    })

    expect(result.title).toBe('Runtime 0.9 release notes')
    expect(result.text.startsWith('# Runtime 0.9 release notes\n\nRelease 0.9')).toBe(true)
  })
})

describe('extractPageContent text format', () => {
  it('strips markdown syntax and keeps table cells readable', async () => {
    const result = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'text',
    })

    expect(result.text).toContain('Retention policy reference')
    expect(result.text).toContain('90 days')
    expect(result.text).not.toContain('##')
    expect(result.text).not.toContain('**')
    expect(result.text).not.toContain('](/')
    expect(result.text).toContain('| Tier | Minimum lock | Maximum lock | Object size limit | Early delete fee |')
    expect(result.text).toMatchSnapshot()
  })

  it('emits title, metadata and excerpt as plain text', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'text',
    })

    const [headline] = result.text.split('\n')
    expect(headline).toBe('How Tidal Bores Reshape Estuaries')
    expect(result.text).toContain('Author: Dana Whitfield | Site: Coastal Review | Published: 2024-11-02T08:30:00Z')
    expect(result.text).toContain('Tidal bores look like a single wave, but they carry sediment budgets')
    expect(result.text).not.toMatch(/^#{1,6} /m)
    expect(result.text).not.toMatch(/^> /m)
    expect(result.text).not.toMatch(/^\*[^*]*\*$/m)
    expect(result.text).not.toContain('**')
    expect(result.text).toMatchSnapshot()
  })
})

describe('extractPageContent character budget', () => {
  it('cuts a single over-long line at the budget instead of returning it whole', async () => {
    const paragraph = 'x'.repeat(400_000)
    const result = await extractPageContent({
      html: `<html><head><title>Long page</title></head><body><article><p>${paragraph}</p></article></body></html>`,
      format: 'markdown',
    })

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(EXTRACT_MAX_CHARS)
    expect(result.text.startsWith('# Long page\n\nxxx')).toBe(true)
    expect(result.text.endsWith('\n[truncated; use search or offset/limit for the rest]')).toBe(true)
    expect(result.totalBytes).toBeGreaterThan(EXTRACT_MAX_CHARS)
  })

  it('cuts an over-long document between lines and reports the full size', async () => {
    const paragraphs = Array.from({ length: 400 }, (_unused, index) => {
      return `<p>Paragraph ${index} ${'y'.repeat(500)}</p>`
    }).join('')
    const result = await extractPageContent({
      html: `<html><head><title>Many paragraphs</title></head><body><article>${paragraphs}</article></body></html>`,
      format: 'markdown',
    })

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(EXTRACT_MAX_CHARS)
    expect(result.text).toContain('Paragraph 0')
    expect(result.text).not.toContain('Paragraph 399')
    expect(result.totalBytes).toBeGreaterThan(200_000)
  })

  it('leaves a document that fits the budget untouched', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'markdown',
    })

    expect(result.truncated).toBe(false)
    expect(result.text.length).toBeLessThan(EXTRACT_MAX_CHARS)
    expect(result.text).not.toContain('[truncated')
  })

  it('returns the whole extraction when the caller persists it', async () => {
    const paragraph = 'z'.repeat(60_000)
    const result = await extractPageContent({
      html: `<html><head><title>Persisted page</title></head><body><article><p>${paragraph}</p></article></body></html>`,
      format: 'markdown',
      full: true,
    })

    expect(result.truncated).toBe(false)
    expect(result.text.length).toBeGreaterThan(EXTRACT_MAX_CHARS)
    expect(result.text).not.toContain('[truncated')
    expect(result.text.trimEnd().endsWith('z')).toBe(true)
  })
})

describe('extractPageContent search windowing', () => {
  it('returns the matching line with five lines of context', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'markdown',
      search: 'pressure transducers',
    })

    expect(result.truncated).toBe(true)
    expect(result.text).toContain('pressure transducers')
    expect(result.text).toContain('### Measuring the front')
    expect(result.text).toContain('- Fine silt travels further')
    expect(result.text).not.toContain('A tidal bore is the leading edge')
    expect(result.text).not.toContain('The remaining question is biological.')
    expect(result.text).toContain('[truncated; use search or offset/limit for the rest]')
    expect(result.text).toMatchSnapshot()
  })

  it('separates non-contiguous match windows with a separator', async () => {
    const filler = Array.from({ length: 40 }, (_unused, index) => {
      return `<p>Filler paragraph ${index} that carries no keywords at all.</p>`
    }).join('')
    const result = await extractPageContent({
      html: `<html><head><title>Window separators</title></head><body><article><h1>Window separators</h1><p>alpha marker sits near the top.</p>${filler}<p>omega marker sits near the bottom.</p></article></body></html>`,
      format: 'markdown',
      search: 'marker',
    })

    const markers = result.text.split('\n---\n')
    expect(markers).toHaveLength(2)
    expect(markers[0]).toContain('alpha marker')
    expect(markers[1]).toContain('omega marker')
  })

  it('keeps distant matches in separate windows', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'markdown',
      search: 'fluid mud',
    })

    const windows = result.text.split('\n---\n')
    expect(windows).toHaveLength(2)
    expect(windows[0]).toContain('*fluid mud*')
    expect(windows[0]).toContain('The feedback loop is slow but persistent.')
    expect(windows[1]).toContain('fluid mud layer thickens')
  })

  it('reports no matches without inventing content', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'markdown',
      search: 'zebra mussel',
    })

    expect(result.text).toContain('No matches found')
    expect(result.truncated).toBe(true)
  })

  it('matches case sensitively like page.snapshot', async () => {
    const result = await extractPageContent({
      html: readFixture('article-typical.html'),
      url: ARTICLE_URL,
      format: 'markdown',
      search: 'TIDAL BORE',
    })

    expect(result.text).toContain('No matches found')
  })
})

describe('extractPageContent pagination', () => {
  it('pages through lines with offset and limit', async () => {
    const full = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
    })
    const window = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
      offset: 2,
      limit: 3,
    })

    expect(window.truncated).toBe(true)
    expect(window.text).toContain('[truncated; use search or offset/limit for the rest]')
    expect(window.text.startsWith('[truncated')).toBe(false)
    const windowLines = window.text.replace('\n[truncated; use search or offset/limit for the rest]', '').split('\n')
    expect(windowLines).toEqual(full.text.split('\n').slice(2, 5))
  })

  it('marks the result complete when the window covers the document', async () => {
    const result = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
      offset: 0,
      limit: 10_000,
    })

    expect(result.truncated).toBe(false)
    expect(result.text).not.toContain('[truncated')
  })

  it('reports an empty window past the end of the document', async () => {
    const result = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
      offset: 100_000,
    })

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('[truncated; use search or offset/limit for the rest]')
  })

  it('reports totalBytes for the full extraction, not the window', async () => {
    const full = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
    })
    const window = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
      limit: 1,
    })

    expect(full.totalBytes).toBe(Buffer.byteLength(full.text, 'utf8'))
    expect(window.totalBytes).toBe(full.totalBytes)
  })

  it('treats a negative offset as the start of the document', async () => {
    const result = await extractPageContent({
      html: readFixture('doc-table.html'),
      url: DOCS_URL,
      format: 'markdown',
      offset: -5,
      limit: 2,
    })

    expect(result.text.startsWith('# Retention policy reference')).toBe(true)
  })
})

describe('extractPageContent robustness', () => {
  it('cleans unpaired surrogates so the text stays JSON encodable', async () => {
    const result = await extractPageContent({
      html: '<html><head><title>Broken \ud800 page</title></head><body><article><p>Body \udfff text here.</p></article></body></html>',
      format: 'markdown',
    })

    expect(result.text).toContain('Body')
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(result.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(() => {
      return JSON.stringify(result)
    }).not.toThrow()
  })

  it('returns empty text for an empty document', async () => {
    const result = await extractPageContent({ html: '', format: 'markdown' })

    expect(result.text).toBe('')
    expect(result.title).toBeUndefined()
    expect(result.truncated).toBe(false)
    expect(result.totalBytes).toBe(0)
  })

  it('extracts content without a url', async () => {
    const result = await extractPageContent({
      html: readFixture('forum-noisy.html'),
      format: 'markdown',
    })

    expect(result.text).toContain('After upgrading to 0.9')
    expect(result.text).toContain('That was it. Confirmed: 13 minutes')
  })
})

describe('extractPageContent silent content loss', () => {
  const indexPage = ({ links }: { links: number }): string => {
    const rows = Array.from({ length: links }, (_unused, index) => {
      return `<a href="/docs/${index}">Guide ${index}: configuring the managed runtime for a shared team workspace</a>`
    }).join('\n')
    const head = '<!doctype html><html><head><title>Documentation index</title></head><body>'
    return `${head}<nav>${rows}</nav></body></html>`
  }

  it('fails explicitly when a long page extracts to nothing', async () => {
    const failure = await extractPageContent({
      html: indexPage({ links: 80 }),
      url: 'https://runtime.example/docs',
      format: 'markdown',
    }).catch((error: unknown) => {
      return error
    })

    expect(failure).toBeInstanceOf(PageExtractError)
    expect((failure as PageExtractError).code).toBe('execution-failed')
    const message = (failure as Error).message
    expect(message.endsWith('; the document body was likely dropped')).toBe(true)
    const [, kept, visible] = /kept only (\d+) of (\d+) visible characters/.exec(message) ?? []
    expect(Number(kept)).toBeLessThanOrEqual(200)
    expect(Number(visible)).toBeGreaterThan(4_000)
  })

  it('keeps returning near-empty text when the page itself is short', async () => {
    const result = await extractPageContent({
      html: indexPage({ links: 3 }),
      url: 'https://runtime.example/docs',
      format: 'markdown',
    })

    expect(result.truncated).toBe(false)
    expect(result.text.length).toBeLessThan(200)
  })

  it('does not fail a long page whose body survives extraction', async () => {
    const paragraphs = Array.from({ length: 30 }, (_unused, index) => {
      return (
        `<p>Paragraph ${index} explains how a group binds to one managed profile and why the runtime never ` +
        `falls back to a default browser when that profile is closed mid-session.</p>`
      )
    }).join('\n')
    const html = [
      '<!doctype html><html><head><title>Managed profiles</title></head><body>',
      '<article><h1>Managed profiles</h1>',
      paragraphs,
      '</article></body></html>',
    ].join('\n')
    const result = await extractPageContent({
      html,
      url: 'https://runtime.example/docs/profiles',
      format: 'markdown',
    })

    expect(result.truncated).toBe(false)
    expect(result.text.length).toBeGreaterThan(4_000)
  })
})
