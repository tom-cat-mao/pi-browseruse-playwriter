import type { ManagedResourceRegistry } from './resource-registry'
import { parseRegistry } from './resource-registry'

/**
 * Persistence for the ownership registry.
 *
 * - chrome.storage.local holds the authoritative per-profile ownership records.
 *   It survives service-worker restarts and browser restarts.
 * - chrome.storage.session holds the browserEpoch: it survives service-worker
 *   restarts but is cleared when Chrome shuts down, which is exactly how we tell
 *   "same Chrome run, worker restarted" apart from "Chrome restarted".
 *
 * Session storage defaults to trusted contexts; we set it explicitly so the
 * ownership/epoch data can never be read from content scripts.
 */

const REGISTRY_STORAGE_KEY = 'piBrowserRegistry'
const BROWSER_EPOCH_STORAGE_KEY = 'piBrowserEpoch'

export function createOpaqueId(prefix: string): string {
  const values = new Uint32Array(2)
  crypto.getRandomValues(values)
  const random = Array.from(values)
    .map((value) => {
      return value.toString(36)
    })
    .join('')
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

export async function restrictSessionStorageToTrustedContexts(): Promise<void> {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    // Older Chrome builds may not expose setAccessLevel; session storage is
    // already trusted-context-only by default, so this is best-effort.
  }
}

export interface BrowserEpochResult {
  browserEpoch: string
  /** true when storage.session had no epoch, i.e. Chrome was restarted (or storage was cleared). */
  restarted: boolean
}

export async function ensureBrowserEpoch(): Promise<BrowserEpochResult> {
  const stored = await chrome.storage.session.get(BROWSER_EPOCH_STORAGE_KEY)
  const existingEpoch = stored[BROWSER_EPOCH_STORAGE_KEY]
  if (typeof existingEpoch === 'string' && existingEpoch.length > 0) {
    return { browserEpoch: existingEpoch, restarted: false }
  }

  const browserEpoch = createOpaqueId('epoch')
  await chrome.storage.session.set({ [BROWSER_EPOCH_STORAGE_KEY]: browserEpoch })
  return { browserEpoch, restarted: true }
}

export async function loadRegistry(): Promise<ManagedResourceRegistry | null> {
  const stored = await chrome.storage.local.get(REGISTRY_STORAGE_KEY)
  return parseRegistry(stored[REGISTRY_STORAGE_KEY])
}

export async function saveRegistry(registry: ManagedResourceRegistry): Promise<void> {
  await chrome.storage.local.set({ [REGISTRY_STORAGE_KEY]: registry })
}
