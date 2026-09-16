import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractPageContent } from './page-extract.js'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures')

const readFixture = (name: string): string => {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8')
}

const ARTICLE_URL = 'https://coastal.example/news/tidal-bores'
const DOCS_URL = 'https://storage.example/docs/retention'
const FORUM_URL = 'https://forum.example/t/build-times'

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
