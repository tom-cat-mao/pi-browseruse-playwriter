/**
 * Minimal HTTP client for the playwriter relay server (Hono, default
 * 127.0.0.1:19988). Zero dependencies — only global fetch + node built-ins.
 *
 * Endpoints used:
 *   GET  /version                  -> { version }
 *   GET  /extension/status         -> { connected, activeTargets, browser, profile, playwriterVersion }
 *   GET  /cli/capabilities         -> { sessionGroups, consent, audit, closeTabs } (B workstream; 404 on stock relay)
 *   POST /cli/session/new          -> { id, mode, extensionId, browser, profile }
 *   POST /cli/execute              -> { text, images, screenshots, isError }
 *   POST /cli/session/delete       -> { success }
 *
 * Auth: when PLAYWRITER_TOKEN is set (remote access / serve --token), every
 * request carries `Authorization: Bearer <token>`.
 */

export const RELAY_PORT = Number(process.env.PLAYWRITER_PORT) || 19988;
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export type Capabilities = {
  sessionGroups: boolean;
  consent: boolean;
  audit: boolean;
  closeTabs: boolean;
};

export type ExecuteScreenshot = {
  path: string;
  base64: string;
  mimeType: "image/png";
  snapshot: string;
  labelCount: number;
};

export type ExecuteResult = {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  screenshots: ExecuteScreenshot[];
  isError: boolean;
};

export type ErrorCategory =
  | "relay-unreachable" // relay not listening (ECONNREFUSED / fetch failed)
  | "extension-disconnected" // relay up, but no Chrome extension attached
  | "session-invalid" // relay answered 404 for our session (deleted/expired)
  | "execute-error" // sandbox threw (isError: true in the response body)
  | "timeout" // fetch aborted (our timeout or pi cancellation)
  | "http"; // any other non-2xx

export class RelayError extends Error {
  category: ErrorCategory;
  status?: number;
  retryable: boolean;

  constructor(category: ErrorCategory, message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(`[${category}] ${message}`, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "RelayError";
    this.category = category;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (category === "relay-unreachable" || category === "timeout");
  }
}

/** Base URL for the relay, honoring PLAYWRITER_HOST (remote access) and PLAYWRITER_PORT. */
export function baseUrl(): string {
  const host = process.env.PLAYWRITER_HOST;
  if (host) {
    const url = host.startsWith("http://") || host.startsWith("https://") ? new URL(host) : new URL(`http://${host}:${RELAY_PORT}`);
    return url.origin;
  }
  return `http://127.0.0.1:${RELAY_PORT}`;
}

function tokenHeader(): Record<string, string> {
  const token = process.env.PLAYWRITER_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getVersion(url: string = baseUrl()): Promise<string | null> {
  try {
    const res = await fetch(`${url}/version`, { signal: AbortSignal.timeout(3000), headers: tokenHeader() });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export type ExtensionStatus = {
  connected: boolean;
  activeTargets: number;
  browser: string | null;
  playwriterVersion: string | null;
};

export async function getExtensionStatus(url: string = baseUrl()): Promise<ExtensionStatus | null> {
  try {
    const res = await fetch(`${url}/extension/status`, { signal: AbortSignal.timeout(3000), headers: tokenHeader() });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      connected?: boolean;
      activeTargets?: number;
      browser?: string | null;
      playwriterVersion?: string | null;
    };
    return {
      connected: data.connected === true,
      activeTargets: data.activeTargets ?? 0,
      browser: data.browser ?? null,
      playwriterVersion: data.playwriterVersion ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Probe relay capabilities. The endpoint belongs to the B workstream
 * (session groups / consent / audit); on a stock relay it 404s or errors,
 * and we silently degrade to all-false. Callers must never hard-depend on it.
 */
export async function getCapabilities(url: string = baseUrl()): Promise<Capabilities> {
  const none: Capabilities = { sessionGroups: false, consent: false, audit: false, closeTabs: false };
  try {
    const res = await fetch(`${url}/cli/capabilities`, { signal: AbortSignal.timeout(3000), headers: tokenHeader() });
    if (!res.ok) return none;
    const data = (await res.json()) as Partial<Capabilities>;
    return { ...none, ...data };
  } catch {
    return none;
  }
}

export type SessionInfo = {
  id: string;
  mode: string;
  browser: string | null;
};

export async function createSession(
  url: string = baseUrl(),
  body: { name?: string; groupTitle?: string } = {},
): Promise<SessionInfo> {
  const res = await fetch(`${url}/cli/session/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tokenHeader() },
    body: JSON.stringify({
      name: body.name,
      // Forward-compatible extra field (contract with B workstream); stock
      // relay parses the body loosely and ignores unknown fields.
      ...(body.groupTitle ? { group_title: body.groupTitle } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RelayError("http", `session/new failed (${res.status}): ${text}`, { status: res.status });
  }
  const data = (await res.json()) as { id?: string | number; error?: string };
  if (!data.id) {
    throw new RelayError("http", `session/new returned no id: ${JSON.stringify(data)}`);
  }
  return { id: String(data.id), mode: "extension", browser: null };
}

export async function deleteSession(sessionId: string, url: string = baseUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${url}/cli/session/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tokenHeader() },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return false;
    return res.ok;
  } catch {
    return false;
  }
}

/** Close all tabs bound to a session via the B-workstream endpoint (closeTabs capability). */
export async function closeSessionTabs(sessionId: string, url: string = baseUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${url}/cli/session/close-tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tokenHeader() },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type ExecuteOptions = {
  sessionId: string;
  code: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  url?: string;
};

/**
 * Run a snippet. Classifies failures:
 *   - network error                -> relay-unreachable (retryable)
 *   - HTTP 404                     -> session-invalid (relay: "Session not found")
 *   - HTTP >= 400                  -> http
 *   - body isError                 -> execute-error (sandbox threw / timeout inside sandbox)
 *   - fetch aborted (pi signal)    -> timeout
 */
export async function execute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const url = opts.url ?? baseUrl();
  const signals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  let res: Response;
  try {
    res = await fetch(`${url}/cli/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tokenHeader() },
      body: JSON.stringify({ sessionId: opts.sessionId, code: opts.code, timeout: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS }),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
    if (aborted) {
      throw new RelayError("timeout", `execute timed out after ${opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS}ms`, { cause: e });
    }
    throw new RelayError(
      "relay-unreachable",
      `relay at ${url} is not reachable (${String(e)}) — start it with \`playwriter session new\``,
      { cause: e },
    );
  }

  if (res.status === 404) {
    throw new RelayError("session-invalid", `session ${opts.sessionId} not found on relay — it will be recreated automatically`, {
      status: 404,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RelayError("http", `execute failed (${res.status}): ${text}`, { status: res.status });
  }

  const data = (await res.json()) as Partial<ExecuteResult> & { error?: string };
  if (data.error) {
    throw new RelayError("http", data.error, { status: res.status });
  }
  const result: ExecuteResult = {
    text: data.text ?? "",
    images: data.images ?? [],
    screenshots: data.screenshots ?? [],
    isError: data.isError === true,
  };
  if (result.isError) {
    throw new RelayError("execute-error", result.text.trim() || "sandbox execution failed", { retryable: false });
  }
  return result;
}

/** Extract the first `MARKER:` line from execute text, if any. */
export function extractMarker(text: string, marker: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${marker}:`)) {
      return trimmed.slice(marker.length + 1).trim();
    }
  }
  return null;
}

/** Extract a URL line like `URL: https://...` from execute text. */
export function extractUrlLine(text: string): string | null {
  return extractMarker(text, "URL");
}
