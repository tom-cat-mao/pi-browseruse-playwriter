import {
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
 * Byte bounds are the shared channel bounds from firefox-executor-protocol.ts;
 * a failed image is reported per image and never fails its siblings or the
 * extraction.
 */
/** One deadline for the whole batch: a hanging image cannot hold the extraction open. */
export const ASSET_FETCH_TIMEOUT_MS = 20_000
const BASE64_CHUNK_BYTES = 0x8000

export async function fetchFirefoxAssets({ request, fetchImpl = fetch }: {
  request: FirefoxAssetFetchRequest
  /** Injectable so a test can observe the request init while still using a real server. */
  fetchImpl?: typeof fetch
}): Promise<FirefoxAssetFetchResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`image fetch exceeded ${ASSET_FETCH_TIMEOUT_MS} ms`))
  }, ASSET_FETCH_TIMEOUT_MS)
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
  const mimeType = imageMimeType({ header: response.headers.get('content-type') })
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
 * Only image payloads are worth saving; a server that answers an image URL with
 * HTML or JSON has not returned an image. `application/octet-stream` is kept
 * because it is what many image CDNs send.
 */
function imageMimeType({ header }: { header: string | null }): string {
  const declared = (header ?? '').split(';')[0].trim().toLowerCase()
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(declared)) {
    return 'application/octet-stream'
  }
  if (declared.startsWith('image/') || declared === 'application/octet-stream') {
    return declared
  }
  throw new Error(`the response is not an image (content-type ${declared})`)
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
