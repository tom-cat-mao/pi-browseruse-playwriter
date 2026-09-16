/**
 * HTML -> Markdown/text extraction pipeline for the managed `page.extract`
 * operation.
 *
 * The browser side only produces high-fidelity HTML; this module runs on the
 * Node side so there is a single extraction implementation for both backends,
 * testable without a browser.
 *
 * Library choice (measured on the three fixtures in `test-fixtures/`, see
 * `docs/exec/content-extract-redesign-plan.md` for the wave that consumes it):
 *
 * - defuddle + linkedom is the implementation. Defuddle keeps document
 *   structure that Readability destroys: it renders `<table>` as a Markdown
 *   pipe table and rewrites relative links to absolute URLs, while
 *   @mozilla/readability + turndown flattened the retention-tier table in
 *   `doc-table.html` into an unreadable run of cells. On a typical article
 *   both are equally clean (no boilerplate, no ads, no nav). linkedom is
 *   ~2.5 MB unpacked and ~20 ms per page versus jsdom's ~4.4 MB and ~100 ms,
 *   with byte-identical output.
 * - Defuddle's boilerplate scorer can mistake the first post of a discussion
 *   page for the whole article (`forum-noisy.html`: 299 of 1216 visible
 *   characters, every reply dropped). A second pass scoped to `<body>` keeps
 *   the replies while still stripping ads, sidebars and footers, so the
 *   pipeline reruns extraction with that scope when the automatic pass comes
 *   back suspiciously sparse. `includeReplies`, `removeLowScoring` and
 *   `removeContentPatterns` had no effect on this case.
 *
 * This module only produces text in memory. Writing artifacts to disk is the
 * artifact store's job.
 */

import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'

export interface PageExtractInput {
  html: string
  /** Document URL, used for absolute link rewriting and metadata. */
  url?: string
  format: 'markdown' | 'text'
  /** Keep matching lines with context (same windowing as page.snapshot). */
  search?: string
  offset?: number
  limit?: number
  /**
   * Return the whole extraction instead of the bounded preview window. Only
   * callers that persist the result (artifacts) use this: the model-facing
   * preview always stays inside the character budget.
   */
  full?: boolean
}

export interface PageExtractMetadata {
  author?: string
  siteName?: string
  publishedTime?: string
  excerpt?: string
}

export interface PageExtractOutput {
  text: string
  title?: string
  metadata?: PageExtractMetadata
  /** True when the returned text is a window of the full extraction. */
  truncated: boolean
  /** UTF-8 byte length of the full extraction, before search/offset/limit. */
  totalBytes: number
}

/**
 * Line caps mirror the page.snapshot renderer: `maxLines` bounds the window,
 * `maxChars` bounds the response and `marker` is appended whenever the caller
 * does not get every line.
 */
const EXTRACT_MAX_LINES = 2_000
/** Character budget for the returned preview, aligned with page.snapshot. */
export const EXTRACT_MAX_CHARS = 40_000
const TRUNCATION_MARKER = '[truncated; use search or offset/limit for the rest]'
const SEARCH_MATCH_LIMIT = 10
const SEARCH_CONTEXT_LINES = 5

/**
 * Below this share of the source document's visible text the automatic
 * content detection is treated as too aggressive for the page.
 */
const SPARSE_CONTENT_RATIO = 0.4

interface ExtractPassResult {
  /** Markdown produced by defuddle. */
  markdown: string
  title: string
  metadata: PageExtractMetadata
}

export async function extractPageContent(input: PageExtractInput): Promise<PageExtractOutput> {
  const extracted = await extractFromHtml({ html: input.html, url: input.url })
  const body = input.format === 'text' ? stripMarkdownToText(extracted.markdown) : extracted.markdown
  const document = assembleDocument({
    title: extracted.title,
    metadata: extracted.metadata,
    body,
    plain: input.format === 'text',
  })
  const fullText = document.toWellFormed()
  const totalBytes = Buffer.byteLength(fullText, 'utf8')
  const result = input.full
    ? { text: fullText, truncated: false }
    : windowExtractedText({
        text: fullText,
        search: input.search,
        offset: input.offset,
        limit: input.limit,
      })

  return {
    text: result.text,
    ...(extracted.title ? { title: extracted.title } : {}),
    ...(hasMetadata(extracted.metadata) ? { metadata: extracted.metadata } : {}),
    truncated: result.truncated,
    totalBytes,
  }
}

/**
 * Apply search, pagination and the character budget to an assembled document.
 * Exported because backends that already hold serialized text (the `html`
 * extraction format) must go through the same budget as the Markdown pipeline.
 * A single over-long line is cut at the budget instead of being dropped or
 * returned whole.
 */
export function windowExtractedText({
  text,
  search,
  offset,
  limit,
  maxChars = EXTRACT_MAX_CHARS,
}: {
  text: string
  search?: string
  offset?: number
  limit?: number
  maxChars?: number
}): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  const selectedLines = search ? selectSearchLines({ lines, search }) : lines
  const start = Number.isInteger(offset) && (offset ?? 0) >= 0 ? (offset ?? 0) : 0
  const maxLines = limit === undefined ? EXTRACT_MAX_LINES : Math.max(0, Math.floor(limit))
  const window = selectedLines.slice(start, start + Math.min(maxLines, EXTRACT_MAX_LINES))
  const windowed = selectedLines.length !== lines.length || start > 0 || window.length < selectedLines.length
  const budgetChars = Math.max(0, maxChars - TRUNCATION_MARKER.length - 1)
  const outputLines: string[] = []
  let usedChars = 0
  let budgetExceeded = false

  for (const line of window) {
    const separatorChars = outputLines.length === 0 ? 0 : 1
    const remaining = budgetChars - usedChars - separatorChars
    if (line.length > remaining) {
      const prefix = remaining > 0 ? sliceUnicodeText({ value: line, maxChars: remaining }) : ''
      if (prefix) {
        outputLines.push(prefix)
      }
      budgetExceeded = true
      break
    }
    outputLines.push(line)
    usedChars += separatorChars + line.length
  }

  const truncated = windowed || budgetExceeded
  let output = outputLines.join('\n')
  if (truncated) {
    output = output ? `${output}\n${TRUNCATION_MARKER}` : TRUNCATION_MARKER
  }
  return { text: output, truncated }
}

async function extractFromHtml({ html, url }: { html: string; url?: string }): Promise<ExtractPassResult> {
  if (!html.trim()) {
    return { markdown: '', title: '', metadata: {} }
  }
  const [automatic, bodyScoped] = await Promise.all([runDefuddlePass({ html, url }), runDefuddlePass({ html, url, scopedToBody: true })])
  const visibleText = estimateVisibleTextLength(html)
  const automaticRatio = visibleText === 0 ? 1 : automatic.markdown.trim().length / visibleText
  if (automaticRatio >= SPARSE_CONTENT_RATIO || bodyScoped.markdown.trim().length <= automatic.markdown.trim().length) {
    return automatic
  }
  return bodyScoped
}

async function runDefuddlePass({
  html,
  url,
  scopedToBody = false,
}: {
  html: string
  url?: string
  scopedToBody?: boolean
}): Promise<ExtractPassResult> {
  const pageUrl = url ?? 'about:blank'
  // `parseHTML` hands back the same Document shape defuddle's node entry takes.
  const { document } = parseHTML(html)
  // `content` carries Markdown once `markdown: true` is set. `contentMarkdown`
  // only exists when browser globals are present, so it is not used here.
  const result = await Defuddle(document as unknown as Document, pageUrl, {
    markdown: true,
    useAsync: false,
    ...(scopedToBody ? { contentSelector: 'body' } : {}),
  })
  return {
    markdown: (result.content ?? '').trim(),
    title: result.title.trim(),
    metadata: {
      ...(result.author.trim() ? { author: result.author.trim() } : {}),
      ...(result.site.trim() ? { siteName: result.site.trim() } : {}),
      ...(result.published.trim() ? { publishedTime: result.published.trim() } : {}),
      ...(result.description.trim() ? { excerpt: result.description.trim() } : {}),
    },
  }
}

function hasMetadata({ author, siteName, publishedTime, excerpt }: PageExtractMetadata): boolean {
  return Boolean(author ?? siteName ?? publishedTime ?? excerpt)
}

/**
 * `plain` (the `text` format) must not leave any Markdown syntax behind, so
 * every block assembled here — not just the body — is emitted as plain text.
 */
function assembleDocument({
  title,
  metadata,
  body,
  plain,
}: {
  title: string
  metadata: PageExtractMetadata
  body: string
  plain: boolean
}): string {
  const blocks: string[] = []
  if (title) {
    blocks.push(plain ? title : `# ${title}`)
  }
  const metadataLine = [
    metadata.author ? `Author: ${metadata.author}` : '',
    metadata.siteName ? `Site: ${metadata.siteName}` : '',
    metadata.publishedTime ? `Published: ${metadata.publishedTime}` : '',
  ].filter(Boolean)
  if (metadataLine.length > 0) {
    const line = metadataLine.join(' | ')
    blocks.push(plain ? line : `*${line}*`)
  }
  if (metadata.excerpt) {
    blocks.push(plain ? metadata.excerpt : `> ${metadata.excerpt}`)
  }
  if (body) {
    blocks.push(body)
  }
  return blocks.join('\n\n').trim()
}

/** Cut a string at a character budget without splitting a surrogate pair. */
function sliceUnicodeText({ value, maxChars }: { value: string; maxChars: number }): string {
  let result = ''
  let chars = 0
  for (const character of value) {
    if (chars + character.length > maxChars) {
      break
    }
    result += character
    chars += character.length
  }
  return result
}

/**
 * Rough size of the text a reader would see, used only to decide whether the
 * automatic extraction dropped most of the page.
 */
function estimateVisibleTextLength(html: string): number {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
}

function stripMarkdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => {
      return block.replace(/```[^\n]*\n?/g, '').trim()
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}> ?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Same windowing contract as page.snapshot: line-level substring match, at
 * most ten matches, five lines of context, `---` between non-contiguous runs.
 */
function selectSearchLines({ lines, search }: { lines: string[]; search: string }): string[] {
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.includes(search))
    .slice(0, SEARCH_MATCH_LIMIT)
  if (matches.length === 0) {
    return ['No matches found']
  }
  const included = new Set<number>()
  matches.forEach(({ index }) => {
    const start = Math.max(0, index - SEARCH_CONTEXT_LINES)
    const end = Math.min(lines.length - 1, index + SEARCH_CONTEXT_LINES)
    for (let current = start; current <= end; current += 1) {
      included.add(current)
    }
  })
  const indices = [...included].sort((left, right) => left - right)
  return indices.reduce<string[]>((result, index, position) => {
    if (position > 0 && indices[position - 1] !== index - 1) {
      result.push('---')
    }
    result.push(lines[index])
    return result
  }, [])
}
