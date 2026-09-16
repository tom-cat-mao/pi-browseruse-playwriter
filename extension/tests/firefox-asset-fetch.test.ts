import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { MAX_FIREFOX_ASSET_BYTES, MAX_FIREFOX_ASSET_COUNT } from 'playwriter/src/firefox-executor-protocol'
import { parseFirefoxAssetRequest } from '../src/firefox-request-validation'
import { fetchFirefoxAssets } from '../src/firefox-asset-fetch'
import type { FirefoxAssetFetchRequest } from 'playwriter/src/firefox-executor-protocol'

const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])
/** One MiB over the per-image budget, streamed so the reader must stop mid-body. */
const OVERSIZED_BYTES = 17 * 1024 * 1024

let server: http.Server
let origin = ''

/** A real server, a real fetch: the handler is only ever exercised over HTTP. */
beforeAll(async () => {
  server = http.createServer((request, response) => {
    const path = request.url ?? '/'
    if (path === '/image.png') {
      response.writeHead(200, { 'content-type': 'image/png; charset=binary', 'content-length': String(IMAGE_BYTES.byteLength) })
      response.end(Buffer.from(IMAGE_BYTES))
      return
    }
    if (path === '/octet.jpg') {
      // A CDN that serves no useful image type still names the file in its URL.
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from('raw-image-bytes'))
      return
    }
    if (path === '/modern.avif') {
      response.writeHead(200, { 'content-type': 'image/avif' })
      response.end(Buffer.from('avif-bytes'))
      return
    }
    if (path === '/page.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>not an image</body></html>')
      return
    }
    if (path === '/declared') {
      // Declares more than the per-image budget without streaming a body.
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(OVERSIZED_BYTES) })
      response.end()
      return
    }
    if (path === '/huge') {
      response.writeHead(200, { 'content-type': 'image/png' })
      const chunk = Buffer.alloc(1024 * 1024, 7)
      for (let sent = 0; sent < 17; sent += 1) {
        response.write(chunk)
      }
      response.end()
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('missing')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { return error ? reject(error) : resolve() })
  })
  server.closeAllConnections()
})

function request({ paths, alt }: { paths: string[]; alt?: string }): FirefoxAssetFetchRequest {
  return {
    requestId: 'request:assets',
    sessionId: 'session-1',
    tabId: 'tab-1',
    browserEpoch: 'epoch-1',
    targets: paths.map((path) => {
      return { src: `${origin}${path}`, ...(alt ? { alt } : {}) }
    }),
  }
}

describe('Firefox background asset fetch', () => {
  test('fetches image bytes with the browser session and reports the served mime type', async () => {
    const inits: RequestInit[] = []
    const recording: typeof fetch = async (input, init) => {
      inits.push(init ?? {})
      return await fetch(input, init)
    }
    const response = await fetchFirefoxAssets({ request: request({ paths: ['/image.png', '/octet.jpg'], alt: 'Hero' }), fetchImpl: recording })
    expect(response.requestId).toBe('request:assets')
    expect(response.error).toBeUndefined()
    expect(response.assets).toHaveLength(2)
    const [image, octet] = response.assets
    if (!image?.ok || !octet?.ok) {
      throw new Error(`expected both images, got ${JSON.stringify(response)}`)
    }
    expect(image).toMatchObject({ src: `${origin}/image.png`, mimeType: 'image/png' })
    expect(Buffer.from(image.base64, 'base64')).toEqual(Buffer.from(IMAGE_BYTES))
    // The URL names the type the artifact store can write.
    expect(octet).toMatchObject({ src: `${origin}/octet.jpg`, mimeType: 'image/jpeg' })
    expect(Buffer.from(octet.base64, 'base64').toString()).toBe('raw-image-bytes')
    // The page's own session is what makes authenticated images load.
    expect(inits).toHaveLength(2)
    expect(inits.every((init) => { return init.credentials === 'include' })).toBe(true)
  })

  test('reports a failure per image without failing its siblings', async () => {
    const response = await fetchFirefoxAssets({ request: request({ paths: ['/missing', '/page.html', '/modern.avif', '/image.png'] }) })
    expect(response.assets.map((asset) => { return asset.ok })).toEqual([false, false, false, true])
    expect(response.assets[0]).toMatchObject({ src: `${origin}/missing`, reason: 'image request failed with HTTP 404' })
    expect(response.assets[1]).toMatchObject({ src: `${origin}/page.html`, reason: 'unsupported image type text/html' })
    // The store can only name files it has a type for, so an unnamed type is refused here.
    expect(response.assets[2]).toMatchObject({ src: `${origin}/modern.avif`, reason: 'unsupported image type image/avif' })
    const saved = response.assets[3]
    if (!saved?.ok) {
      throw new Error('expected the third image to be saved')
    }
    expect(Buffer.from(saved.base64, 'base64')).toEqual(Buffer.from(IMAGE_BYTES))
  })

  test('refuses an image that is over the per-image byte budget and keeps the rest', async () => {
    const response = await fetchFirefoxAssets({ request: request({ paths: ['/declared', '/image.png'] }) })
    expect(response.assets[0]).toMatchObject({ src: `${origin}/declared`, ok: false, reason: `image is ${OVERSIZED_BYTES} bytes, over the ${MAX_FIREFOX_ASSET_BYTES}-byte limit` })
    expect(response.assets[1]).toMatchObject({ src: `${origin}/image.png`, ok: true })
    // The streamed body is cut at the limit instead of being buffered whole.
    const streamed = await fetchFirefoxAssets({ request: request({ paths: ['/huge'] }) })
    expect(streamed.assets[0]).toMatchObject({ ok: false, reason: `image is over the ${MAX_FIREFOX_ASSET_BYTES}-byte limit` })
  })
})

describe('Firefox asset request validation', () => {
  const valid = {
    requestId: 'request:assets',
    sessionId: 'session-1',
    tabId: 'tab-1',
    browserEpoch: 'epoch-1',
    targets: [{ src: 'https://cdn.example.test/hero.png', alt: 'Hero' }, { src: 'http://cdn.example.test/logo.png' }],
  }

  test('accepts the canonical request and keeps its identity', () => {
    expect(parseFirefoxAssetRequest(valid)).toEqual(valid)
  })

  test('rejects scope changes, unknown fields and non-web targets', () => {
    expect(parseFirefoxAssetRequest({ ...valid, targetRequestId: 'other' })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, sessionId: '  ' })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, tabId: 't'.repeat(257) })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, targets: [] })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, targets: [{ src: `https://cdn.example.test/${'a'.repeat(8_200)}.png` }] })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, targets: [{ src: 'javascript:alert(1)' }] })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, targets: [{ src: 'blob:https://example.test/9c1f' }] })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, targets: [{ src: 'https://cdn.example.test/a.png', extra: 1 }] })).toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, targets: [{ src: 'https://cdn.example.test/a.png', alt: 'a'.repeat(1_001) }] })).toBeNull()
  })

  test('bounds one request to twenty images', () => {
    const targets = Array.from({ length: MAX_FIREFOX_ASSET_COUNT + 1 }, (_value, index) => {
      return { src: `https://cdn.example.test/${index}.png` }
    })
    expect(parseFirefoxAssetRequest({ ...valid, targets: targets.slice(0, MAX_FIREFOX_ASSET_COUNT) })).not.toBeNull()
    expect(parseFirefoxAssetRequest({ ...valid, targets })).toBeNull()
  })
})
