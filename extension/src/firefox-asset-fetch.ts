import {
  FIREFOX_ASSET_FETCH_TIMEOUT_MS,
  MAX_FIREFOX_ASSET_BYTES,
  MAX_FIREFOX_ASSET_REASON_LENGTH,
  MAX_FIREFOX_ASSET_TOTAL_BYTES,
} from 'playwriter/src/firefox-executor-protocol'
import type {
  FirefoxAssetFetchRequest,
  FirefoxAssetFetchResponse,
  FirefoxAssetOutcome,
} from 'playwriter/src/firefox-executor-protocol'

/**
 * Image bytes for `page.extract` images:'save' are read here, in the extension
 * background, because this is the only place a Firefox image can be fetched
 * with the browser's cookies and without CORS: the extension holds <all_urls>
 * host permissions, so an authenticated or third-party image loads exactly as
 * the page would load it.
 *
 * Byte bounds and the batch deadline are the shared channel bounds from
 * firefox-executor-protocol.ts; a failed image is reported per image and never
 * fails its siblings or the extraction. The byte bound also keeps one answer
 * inside the channel's 96 MiB frame budget — 64 MiB of image bytes is 85.4 MiB
 * of base64 — which is itself inside the relay's 100 MiB websocket default, so
 * a full batch is never cut. The same image types the artifact store can name
 * are accepted, in the same order of preference the Chrome backend uses, so a
 * saved image always has a file the store can write.
 */
const BASE64_CHUNK_BYTES = 0x8000
/** Types the runtime's artifact store can name a file with. */
const SAVED_ASSET_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])
/** Fallback for responses that do not declare an image content type. */
const ASSET_MIME_TYPE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

export async function fetchFirefoxAssets({ request, fetchImpl = fetch }: {
  request: FirefoxAssetFetchRequest
  /** Injectable so a test can observe the request init while still using a real server. */
  fetchImpl?: typeof fetch
}): Promise<FirefoxAssetFetchResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`image fetch exceeded ${FIREFOX_ASSET_FETCH_TIMEOUT_MS} ms`))
  }, FIREFOX_ASSET_FETCH_TIMEOUT_MS)
  const assets: FirefoxAssetOutcome[] = []
  let usedBytes = 0
  try {
    for (const target of request.targets) {
      const remaining = MAX_FIREFOX_ASSET_TOTAL_BYTES - usedBytes
      if (remaining <= 0) {
        assets.push({ src: target.src, ok: false, reason: 'image byte budget exhausted: 64 MiB per extraction' })
        continue
      }
      try {
        const image = await fetchAsset({ src: target.src, signal: controller.signal, byteLimit: Math.min(MAX_FIREFOX_ASSET_BYTES, remaining), fetchImpl })
        usedBytes += image.bytes
        assets.push({ src: target.src, ok: true, base64: image.base64, mimeType: image.mimeType })
      } catch (error) {
        assets.push({ src: target.src, ok: false, reason: reasonOf(error) })
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return { requestId: request.requestId, assets }
}

async function fetchAsset({ src, signal, byteLimit, fetchImpl }: {
  src: string
  signal: AbortSignal
  byteLimit: number
  fetchImpl: typeof fetch
}): Promise<{ base64: string; mimeType: string; bytes: number }> {
  const response = await fetchImpl(src, { credentials: 'include', redirect: 'follow', signal })
  if (!response.ok) {
    throw new Error(`image request failed with HTTP ${response.status}`)
  }
  const mimeType = resolveAssetMimeType({ declared: response.headers.get('content-type'), url: src })
  if (!SAVED_ASSET_MIME_TYPES.has(mimeType)) {
    throw new Error(`unsupported image type ${mimeType}`)
  }
  const bytes = await readBoundedBody({ response, byteLimit })
  return { base64: toBase64(bytes), mimeType, bytes: bytes.byteLength }
}

/**
 * The body is read in chunks and cancelled the moment it passes the limit, so a
 * hostile or mislabelled image cannot make the background buffer it whole.
 */
async function readBoundedBody({ response, byteLimit }: { response: Response; byteLimit: number }): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > byteLimit) {
    throw new Error(`image is ${declared} bytes, over the ${byteLimit}-byte limit`)
  }
  const body = response.body
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > byteLimit) {
      throw new Error(`image is ${buffer.byteLength} bytes, over the ${byteLimit}-byte limit`)
    }
    return buffer
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      if (!chunk.value?.byteLength) {
        continue
      }
      total += chunk.value.byteLength
      if (total > byteLimit) {
        throw new Error(`image is over the ${byteLimit}-byte limit`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Prefer a type the store knows; otherwise fall back to the file name, because
 * a CDN that serves `application/octet-stream` still names the image in its URL.
 * Anything else is reported as an unsupported image type by the caller.
 */
function resolveAssetMimeType({ declared, url }: { declared: string | null; url: string }): string {
  const normalized = (declared ?? '').split(';')[0].trim().toLowerCase()
  if (SAVED_ASSET_MIME_TYPES.has(normalized)) {
    return normalized
  }
  const pathname = url.split(/[?#]/)[0]
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')
  const extension = dot === -1 ? '' : lastSegment.slice(dot + 1).toLowerCase()
  return ASSET_MIME_TYPE_EXTENSIONS[extension] ?? normalized
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  }
  return btoa(binary)
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message || 'image fetch failed').slice(0, MAX_FIREFOX_ASSET_REASON_LENGTH)
}
