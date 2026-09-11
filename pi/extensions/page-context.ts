/**
 * Session-scoped page-context cache for the human-facing tool rows.
 *
 * The tools already receive page facts from the runtime (a returned tab, a
 * `tabs.list`, or the optional `pageInfo` observation on page operations), so
 * the UI can remember "which page is this tabId on" without ever issuing an
 * extra browser call. The cache is keyed by Pi session UUID and every read
 * requires the exact session, so one session can never surface another
 * session's titles. It is bounded (LRU by tab) and cleared on session
 * shutdown.
 *
 * Renderers do not receive an ExtensionContext, so `bindResultSession()` links
 * the (UI-only, never serialized) tool `details` object of the current result
 * to its session id via a WeakMap. Restored rows simply get no context.
 */
import { clampBytes, stripTerminalControls } from "./ui-format.ts";

export type ObservedPage = {
  tabId: string;
  url: string;
  title?: string;
};

const MAX_FIELD_BYTES = 2_000;

const resultSessions = new WeakMap<object, string>();

/** Link the details object of one tool result to the session that produced it. */
export function bindResultSession(details: object, sessionId: string): void {
  if (!sessionId) return;
  resultSessions.set(details, sessionId);
}

/** Session that produced a result, or undefined for restored/stale rows. */
export function boundResultSession(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  return resultSessions.get(details);
}

/** Bounded, session-isolated store of observed page context. */
export class PageContextStore {
  private readonly bySession = new Map<string, Map<string, ObservedPage>>();
  private readonly maxEntriesPerSession: number;

  constructor(maxEntriesPerSession = 64) {
    this.maxEntriesPerSession = Math.max(1, maxEntriesPerSession);
  }

  /**
   * Record an observed page for a session. Refreshes recency on update and
   * evicts the oldest tab when the bound is exceeded. Unknown sessions and
   * malformed observations are ignored.
   */
  observe(sessionId: string | undefined, page: ObservedPage): void {
    if (!sessionId) return;
    const tabId = stripTerminalControls(page.tabId).trim();
    if (!tabId) return;
    let entries = this.bySession.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.bySession.set(sessionId, entries);
    }
    entries.delete(tabId);
    entries.set(tabId, {
      tabId,
      url: clampBytes(stripTerminalControls(page.url), MAX_FIELD_BYTES),
      ...(page.title ? { title: clampBytes(stripTerminalControls(page.title), MAX_FIELD_BYTES) } : {}),
    });
    while (entries.size > this.maxEntriesPerSession) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  /** Page context for one tab in one session; never crosses sessions. */
  lookup(sessionId: string | undefined, tabId: unknown): ObservedPage | undefined {
    if (!sessionId || typeof tabId !== "string") return undefined;
    return this.bySession.get(sessionId)?.get(tabId);
  }

  /** Drop one session's context, or everything when no session is given. */
  clear(sessionId?: string): void {
    if (sessionId) this.bySession.delete(sessionId);
    else this.bySession.clear();
  }
}
