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
 * Both areas are pinned to trusted contexts so ownership/epoch data can never be
 * read from content scripts. Read/write failures are surfaced, never swallowed:
 * the managed layer must not advertise state it could not persist.
 */

const REGISTRY_STORAGE_KEY = 'piBrowserRegistry'
const BROWSER_EPOCH_STORAGE_KEY = 'piBrowserEpoch'

export class RegistryStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryStorageError'
  }
}

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

export async function restrictStorageToTrustedContexts(): Promise<void> {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    // Older Chrome builds may not expose setAccessLevel; session storage is
    // already trusted-context-only by default, so this is best-effort.
  }
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    // Same for local storage; access-level pinning is defense in depth.
  }
}

export interface BrowserEpochResult {
  browserEpoch: string
  /** true when storage.session had no epoch, i.e. Chrome was restarted (or storage was cleared). */
  restarted: boolean
}

/**
 * Returns the browser-run epoch. A missing session value means the browser was
 * restarted OR session storage was cleared; either way the previous run's
 * chromeTabId/chromeGroupId values may now belong to unrelated tabs (Chrome
 * hands out low numeric ids again after a restart), so callers must reconcile
 * those records into needs-rebind instead of reusing the numeric Chrome ids.
 */
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

/**
 * Reads the persisted registry.
 *
 * - returns null only when nothing was ever stored;
 * - throws when storage is unreadable or the stored value is malformed, so the
 *   caller can keep the managed layer unavailable instead of overwriting records
 *   it could not read.
 */
export async function loadRegistry(): Promise<ManagedResourceRegistry | null> {
  const stored = await chrome.storage.local.get(REGISTRY_STORAGE_KEY)
  const raw = stored[REGISTRY_STORAGE_KEY]
  if (raw === undefined || raw === null) {
    return null
  }
  const registry = parseRegistry(raw)
  if (!registry) {
    throw new RegistryStorageError('persisted managed registry is malformed')
  }
  return registry
}

export async function saveRegistry(registry: ManagedResourceRegistry): Promise<void> {
  await chrome.storage.local.set({ [REGISTRY_STORAGE_KEY]: registry })
}
