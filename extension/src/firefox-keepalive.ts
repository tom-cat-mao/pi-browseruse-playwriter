import type { FirefoxApi } from './firefox-api'

export async function keepFirefoxBackgroundActive(api: FirefoxApi): Promise<void> {
  try {
    await api.runtime.getBrowserInfo()
  } catch (error) {
    console.debug('Firefox background keepalive failed:', error instanceof Error ? error.message : String(error))
  }
}
