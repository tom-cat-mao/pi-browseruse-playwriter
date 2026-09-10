import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  ALLOWED_EXTENSION_IDS,
  DEFAULT_BROWSER_DATA_DIR,
  DEFAULT_BROWSER_RUNTIME_PORT,
  EXTENSION_IDS,
  FORK_EXTENSION_IDS,
  getCdpUrl,
  parseRelayHost,
  resolveBrowserRuntimeConfig,
} from './utils.js'

describe('resolveBrowserRuntimeConfig', () => {
  it('defaults to loopback, 19989 and the managed data dir', () => {
    const config = resolveBrowserRuntimeConfig({ env: {} })

    expect(config).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_BROWSER_RUNTIME_PORT,
      token: undefined,
      dataDir: DEFAULT_BROWSER_DATA_DIR,
      logFilePath: path.join(os.homedir(), '.pi-browser-use', 'relay-server.log'),
      cdpLogFilePath: path.join(os.homedir(), '.pi-browser-use', 'cdp.jsonl'),
    })
    expect(DEFAULT_BROWSER_RUNTIME_PORT).toBe(19989)
  })

  it('reads PI_BROWSER_* overrides', () => {
    const config = resolveBrowserRuntimeConfig({
      env: {
        PI_BROWSER_HOST: '0.0.0.0',
        PI_BROWSER_PORT: '21000',
        PI_BROWSER_TOKEN: 'secret',
        PI_BROWSER_DATA_DIR: '/var/lib/pi-browser',
        PI_BROWSER_LOG_FILE_PATH: '/var/log/pi.log',
        PI_BROWSER_CDP_LOG_FILE_PATH: '/var/log/pi-cdp.jsonl',
      },
    })

    expect(config).toEqual({
      host: '0.0.0.0',
      port: 21000,
      token: 'secret',
      dataDir: '/var/lib/pi-browser',
      logFilePath: '/var/log/pi.log',
      cdpLogFilePath: '/var/log/pi-cdp.jsonl',
    })
  })

  it('ignores invalid ports instead of starting on NaN', () => {
    expect(resolveBrowserRuntimeConfig({ env: { PI_BROWSER_PORT: 'not-a-port' } }).port).toBe(19989)
    expect(resolveBrowserRuntimeConfig({ env: { PI_BROWSER_PORT: '0' } }).port).toBe(19989)
    expect(resolveBrowserRuntimeConfig({ env: { PI_BROWSER_PORT: '-1' } }).port).toBe(19989)
    expect(resolveBrowserRuntimeConfig({ env: { PI_BROWSER_PORT: '19989.5' } }).port).toBe(19989)
  })
})

describe('extension allowlist', () => {
  it('keeps legacy IDs and adds the fork dev ID', () => {
    expect(EXTENSION_IDS).toEqual([
      'jfeammnjpkecdekppnclgkkffahnhfhe',
      'pebbngnfojnignonigcnkdilknapkgid',
    ])
    expect(FORK_EXTENSION_IDS).toEqual(['eeklahpecooapnailfaebkjjembkjhhg'])
    expect(ALLOWED_EXTENSION_IDS).toMatchInlineSnapshot(`
      [
        "jfeammnjpkecdekppnclgkkffahnhfhe",
        "pebbngnfojnignonigcnkdilknapkgid",
        "eeklahpecooapnailfaebkjjembkjhhg",
      ]
    `)
  })
})

describe('relay url helpers', () => {
  it('parses plain hosts with a port and full urls as-is', () => {
    expect(parseRelayHost('192.168.1.10')).toEqual({
      httpBaseUrl: 'http://192.168.1.10:19988',
      wsBaseUrl: 'ws://192.168.1.10:19988',
    })
    expect(parseRelayHost('https://machine.traforo.dev')).toEqual({
      httpBaseUrl: 'https://machine.traforo.dev',
      wsBaseUrl: 'wss://machine.traforo.dev',
    })
  })

  it('builds a managed cdp url with port and token', () => {
    const url = new URL(
      getCdpUrl({ port: 19989, token: 'secret', extensionId: 'eeklahpecooapnailfaebkjjembkjhhg' }),
    )

    expect(url.protocol).toBe('ws:')
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).toBe('19989')
    expect(url.pathname.startsWith('/cdp/')).toBe(true)
    expect(url.searchParams.get('token')).toBe('secret')
    expect(url.searchParams.get('extensionId')).toBe('eeklahpecooapnailfaebkjjembkjhhg')
  })
})
