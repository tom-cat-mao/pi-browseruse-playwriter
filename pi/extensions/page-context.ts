/**
 * Session-scoped page-context cache for human-facing rows.
 *
 * Observed page facts (returned tabs, optional pageInfo) are remembered per Pi
 * session so later rows on the same tab can show a title/domain without an
 * extra browser call. Reads require the exact session, both sessions and their
 * tabs are bounded, and session shutdown clears its context. Renderers do not
 * receive an ExtensionContext, so `bindResultSession()` links a result's
 * UI-only details object to its session through a WeakMap; restored rows get
 * no context.
 */
import { clampBytes, stripTerminalControls } from "./ui-format.ts";

export type ObservedPage = {
  tabId: string;
  url: string;
  title?: string;
};

const MAX_FIELD_BYTES = 2_000;
const MAX_PAGES_PER_SESSION = 64;
const MAX_SESSIONS = 16;

const resultSessions = new WeakMap<object, string>();

/** Link the details object of one result to the session that produced it. */
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

  /** Record one observation; refreshes recency and evicts at both bounds. */
  observe(sessionId: string | undefined, page: ObservedPage): void {
    if (!sessionId) return;
    const tabId = stripTerminalControls(page.tabId).trim();
    if (!tabId) return;
    let entries = this.bySession.get(sessionId);
    if (entries) {
      // Refresh session recency so active sessions survive the session cap.
      this.bySession.delete(sessionId);
    } else {
      entries = new Map();
    }
    this.bySession.set(sessionId, entries);
    entries.delete(tabId);
    entries.set(tabId, {
      tabId,
      url: clampBytes(stripTerminalControls(page.url), MAX_FIELD_BYTES),
      ...(page.title ? { title: clampBytes(stripTerminalControls(page.title), MAX_FIELD_BYTES) } : {}),
    });
    while (entries.size > MAX_PAGES_PER_SESSION) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    while (this.bySession.size > MAX_SESSIONS) {
      const oldest = this.bySession.keys().next().value;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
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
