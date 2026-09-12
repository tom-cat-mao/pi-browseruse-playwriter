/**
 * Typed HTTP client for the managed browser runtime (`@tom-cat/pi-browser-runtime`,
 * default 127.0.0.1:19989). Talks the frozen v1 contract only — never the legacy
 * playwriter relay on 19988.
 *
 * Endpoints (browser-runtime-contract.md):
 *   GET  /browser/v1/capabilities -> BrowserCapabilities
 *   GET  /browser/v1/profiles     -> { profiles: BrowserProfile[] }
 *   POST /browser/v1/request      -> BrowserRequest -> BrowserResponse
 *
 * Wire rules:
 *   - every request carries requestId + sessionId (sessionId is the Pi session
 *     UUID, injected by the caller — never an LLM parameter).
 *   - malformed body -> HTTP 400; unauthenticated -> 401; normal protocol
 *     responses (including business failures) -> 200 + { ok:false } which we
 *     surface verbatim via RuntimeRequestError so the LLM sees code/outcome.
 *   - responses are validated at runtime (not just TypeScript casts).
 *   - cancellation uses a SEPARATE request.cancel call with a fresh (non-aborted)
 *     signal; we never retry or replay page actions.
 *
 * Types are imported type-only from the runtime package export; at runtime this
 * module only speaks HTTP + node built-ins (global fetch).
 */

import type {
  BrowserCapabilities,
  BrowserErrorCode,
  BrowserNetworkCaptureStatus,
  BrowserOperation,
  BrowserPageOperation,
  BrowserProfile,
  BrowserRequest,
  BrowserResponse,
  BrowserResultData,
} from "@tom-cat/pi-browser-runtime/browser-protocol";

export const DEFAULT_RUNTIME_PORT = 19989;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
/**
 * Transport time granted past the operation deadline so the runtime can return
 * its typed `timeout` instead of the client aborting in the same tick. The
 * operation deadline itself is still `timeoutMs` (capped at 120s).
 */
export const TRANSPORT_RESPONSE_GRACE_MS = 5_000;
// The largest response body we will read into memory. Generous enough for a
// couple of full-page screenshots (base64), but bounded so a runaway runtime
// cannot exhaust memory.
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// Per-image base64 ceiling enforced during validation so one giant image does
// not slip past MAX_RESPONSE_BYTES undetected.
const MAX_IMAGE_BASE64_BYTES = 24 * 1024 * 1024;

// The protocol version this client speaks. Hardcoded (not imported as a runtime
// value) so this module never loads runtime JS; kept in lockstep with the frozen
// contract's BROWSER_PROTOCOL_VERSION.
const EXPECTED_PROTOCOL_VERSION = 1;

/** Categories for transport/protocol failures the LLM should distinguish. */
export type RuntimeErrorCategory =
  | "runtime-unreachable" // fetch failed (ECONNREFUSED / DNS / TCP)
  | "unauthorized" // HTTP 401 (token missing/wrong)
  | "bad-request" // HTTP 400 (malformed request rejected by runtime)
  | "protocol" // 200 body failed runtime validation
  | "timeout" // fetch aborted by our deadline or the caller's signal
  | "http" // any other non-2xx
  | "operation"; // 200 + { ok:false } business/operation failure

/**
 * A failure surfaced to the LLM. For operation failures (`category:"operation"`)
 * the runtime's own `code`/`outcome` are preserved so the model can reason about
 * whether a page action may have partially happened.
 */
export class RuntimeRequestError extends Error {
  category: RuntimeErrorCategory;
  status?: number;
  code?: BrowserErrorCode;
  outcome?: "not-started" | "unknown";

  constructor(
    category: RuntimeErrorCategory,
    message: string,
    opts: {
      status?: number;
      code?: BrowserErrorCode;
      outcome?: "not-started" | "unknown";
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "RuntimeRequestError";
    this.category = category;
    this.status = opts.status;
    this.code = opts.code;
    this.outcome = opts.outcome;
  }
}

export type RuntimeClientConfig = {
  baseUrl: string;
  token?: string;
};

/** Resolve runtime config from PI_BROWSER_HOST / PI_BROWSER_PORT / PI_BROWSER_TOKEN. */
export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeClientConfig {
  const token = env.PI_BROWSER_TOKEN || undefined;
  const port = resolvePort(env.PI_BROWSER_PORT);
  const host = env.PI_BROWSER_HOST;
  const baseUrl = (() => {
    if (!host) return `http://127.0.0.1:${port}`;
    if (host.startsWith("http://") || host.startsWith("https://")) {
      return new URL(host).origin;
    }
    // Bracket bare IPv6 literals so the URL parser accepts them (mirrors the
    // runtime side, which listens on 127.0.0.1 by default).
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return new URL(`http://${authority}:${port}`).origin;
  })();
  return { baseUrl, token };
}

/** Parse PI_BROWSER_PORT, rejecting non-numeric or out-of-range values loudly. */
function resolvePort(raw: string | undefined): number {
  if (raw == null || raw === "") return DEFAULT_RUNTIME_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PI_BROWSER_PORT must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function authHeaders(config: RuntimeClientConfig): Record<string, string> {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(res: Response): Promise<unknown> {
  const raw = await readBounded(res);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new RuntimeRequestError("protocol", `runtime returned non-JSON body (${res.status})`, {
      status: res.status,
      cause: e,
    });
  }
}

/**
 * Read a response body but stop once MAX_RESPONSE_BYTES is exceeded, so a
 * misbehaving runtime cannot make us buffer unbounded data. Uses the streaming
 * reader when available and falls back to text() otherwise (test servers).
 */
async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new RuntimeRequestError("protocol", `runtime response exceeded ${MAX_RESPONSE_BYTES} bytes`, {
        status: res.status,
      });
    }
    return text;
  }
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new RuntimeRequestError("protocol", `runtime response exceeded ${MAX_RESPONSE_BYTES} bytes`, {
        status: res.status,
      });
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Map a non-2xx status onto a transport error, reading the body for detail. */
async function httpError(res: Response, endpoint: string): Promise<RuntimeRequestError> {
  // Read the error body for context. If the read itself fails — typically an
  // abort/timeout while the body is still streaming — rethrow the raw error so
  // the caller's boundary (toTransportError, which knows the signal + mutating
  // flag) can classify it as a timeout (outcome:unknown for a mutating request)
  // rather than reporting a misleading plain http error.
  const body = await res.text();
  const detail = body ? `: ${body.slice(0, 512)}` : "";
  if (res.status === 401) {
    return new RuntimeRequestError("unauthorized", `runtime rejected auth on ${endpoint} (401)${detail}`, {
      status: 401,
    });
  }
  if (res.status === 400) {
    return new RuntimeRequestError("bad-request", `runtime rejected ${endpoint} (400)${detail}`, { status: 400 });
  }
  return new RuntimeRequestError("http", `${endpoint} failed (${res.status})${detail}`, { status: res.status });
}

function toTransportError(
  e: unknown,
  endpoint: string,
  baseUrl: string,
  opts: { mutating?: boolean; signal?: AbortSignal } = {},
): RuntimeRequestError {
  // An abort can surface as an AbortError/TimeoutError DOMException, or — when
  // the caller aborts with a custom reason — as that reason itself. It can also
  // surface INDIRECTLY: a non-2xx body read that is cut short by the abort
  // resolves with a partial body and yields a plain http error, but the signal
  // is now aborted. In all these cases a mutating POST may already have run, so
  // treat a caller-aborted exchange as a timeout regardless of the concrete
  // error, and attach outcome:"unknown" for mutating requests (reads carry no
  // outcome).
  const abortedName = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
  const callerAborted = opts.signal?.aborted ?? false;
  if (abortedName || callerAborted) {
    return new RuntimeRequestError("timeout", `${endpoint} aborted before a response arrived`, {
      cause: e,
      ...(opts.mutating ? { outcome: "unknown" as const } : {}),
    });
  }
  if (e instanceof RuntimeRequestError) return e;
  return new RuntimeRequestError(
    "runtime-unreachable",
    `browser runtime at ${baseUrl} is not reachable (${String(e)})`,
    { cause: e },
  );
}

// --- runtime response validation --------------------------------------------

function validateCapabilities(value: unknown): BrowserCapabilities {
  if (!isRecord(value)) {
    throw new RuntimeRequestError("protocol", "capabilities response is not an object");
  }
  const cap = value as Partial<BrowserCapabilities>;
  if (
    typeof cap.protocolVersion !== "number" ||
    typeof cap.managedGroups !== "boolean" ||
    typeof cap.persistentOwnership !== "boolean" ||
    typeof cap.explicitTabs !== "boolean" ||
    typeof cap.isolatedExecution !== "boolean"
  ) {
    throw new RuntimeRequestError("protocol", "capabilities response is missing required fields");
  }
  if (cap.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    throw new RuntimeRequestError(
      "protocol",
      `runtime speaks protocol v${cap.protocolVersion}, this client requires v${EXPECTED_PROTOCOL_VERSION}`,
    );
  }
  // The managed contract only makes sense when the runtime actually manages
  // groups, exposes explicit tabs, and isolates execution — reject a relay that
  // claims v1 but does not support the managed model we depend on.
  if (!cap.managedGroups || !cap.explicitTabs || !cap.isolatedExecution) {
    throw new RuntimeRequestError(
      "protocol",
      "runtime does not advertise the managed capabilities (managedGroups/explicitTabs/isolatedExecution)",
    );
  }
  if (cap.existingTabControl !== undefined && typeof cap.existingTabControl !== "boolean") {
    throw new RuntimeRequestError("protocol", "capabilities existingTabControl is not a boolean");
  }
  const modes = {
    backend: ["cdp", "webextension"],
    inputMode: ["native", "dom"],
    snapshotMode: ["native-ax", "dom-aria"],
    executeMode: ["playwright", "dom-compatible"],
    evaluateWorld: ["page", "isolated"],
  } satisfies Partial<Record<keyof BrowserCapabilities, string[]>>;
  for (const [key, allowed] of Object.entries(modes)) {
    const mode = value[key];
    if (mode !== undefined && (typeof mode !== "string" || !allowed.includes(mode))) {
      throw new RuntimeRequestError("protocol", `capabilities ${key} is not a supported mode`);
    }
  }
  if (
    cap.limitations !== undefined &&
    (!Array.isArray(cap.limitations) || cap.limitations.length > 32 ||
      cap.limitations.some((item) => {
        return typeof item !== "string" || item.length > 2_000;
      }))
  ) {
    throw new RuntimeRequestError("protocol", "capabilities limitations must be a bounded array of strings");
  }
  const supportedOperations: readonly BrowserPageOperation["kind"][] = [
    "page.navigate", "page.back", "page.snapshot", "page.click", "page.fill",
    "page.evaluate", "page.screenshot", "page.network", "page.logs", "page.execute",
  ];
  if (
    cap.supportedOperations !== undefined &&
    (!Array.isArray(cap.supportedOperations) || cap.supportedOperations.length > supportedOperations.length ||
      cap.supportedOperations.some((operation) => {
        return !supportedOperations.includes(operation);
      }))
  ) {
    throw new RuntimeRequestError("protocol", "capabilities supportedOperations contains an invalid page operation");
  }
  return value as unknown as BrowserCapabilities;
}

function validateProfile(value: unknown): BrowserProfile {
  if (!isRecord(value)) {
    throw new RuntimeRequestError("protocol", "profile entry is not an object");
  }
  const p = value as Partial<BrowserProfile>;
  if (
    typeof p.profileId !== "string" ||
    typeof p.browser !== "string" ||
    typeof p.label !== "string" ||
    typeof p.connected !== "boolean" ||
    typeof p.browserEpoch !== "string"
  ) {
    throw new RuntimeRequestError("protocol", "profile entry is missing required fields");
  }
  // capabilities is a required nested object on the contract; validate it too so
  // a truncated profile is caught here rather than surfacing as undefined later.
  validateCapabilities(p.capabilities);
  return value as unknown as BrowserProfile;
}

// Capture lifecycle values as frozen in the protocol type.
const NETWORK_CAPTURE_STATUSES: readonly BrowserNetworkCaptureStatus[] = [
  "active",
  "stopped",
  "interrupted",
  "not-started",
];

function isCaptureStatus(value: string): value is BrowserNetworkCaptureStatus {
  return (NETWORK_CAPTURE_STATUSES as readonly string[]).includes(value);
}

/** Validate the optional frozen `data.pageInfo {tabId, url, title?}` observation. */
function validatePageInfo(value: unknown): void {
  if (!isRecord(value) || typeof value.tabId !== "string" || typeof value.url !== "string") {
    throw new RuntimeRequestError("protocol", "result data.pageInfo is missing tabId/url");
  }
  if (value.title !== undefined && typeof value.title !== "string") {
    throw new RuntimeRequestError("protocol", "result data.pageInfo.title is not a string");
  }
}

/** Validate the optional frozen `data.networkCapture` capture metadata. */
function validateNetworkCapture(value: unknown): void {
  if (!isRecord(value)) {
    throw new RuntimeRequestError("protocol", "result data.networkCapture is not an object");
  }
  const status = value.status;
  if (typeof status !== "string" || !isCaptureStatus(status)) {
    throw new RuntimeRequestError("protocol", "result data.networkCapture.status is not a known capture state");
  }
  if (value.captureId !== undefined && typeof value.captureId !== "string") {
    throw new RuntimeRequestError("protocol", "result data.networkCapture.captureId is not a string");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new RuntimeRequestError("protocol", "result data.networkCapture.reason is not a string");
  }
  for (const key of ["retainedCount", "droppedCount"] as const) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      throw new RuntimeRequestError("protocol", `result data.networkCapture.${key} is not a non-negative number`);
    }
  }
}

/**
 * Validate the typed shape of a success payload's data. We do not reject
 * unknown extra keys (forward-compat), but every field we surface to the LLM is
 * checked so a wrongly-typed array/image can't slip through as if it were data.
 */
function validateResultData(data: Record<string, unknown>): void {
  if (data.text !== undefined && typeof data.text !== "string") {
    throw new RuntimeRequestError("protocol", "result data.text is not a string");
  }
  if (data.snapshotId !== undefined && typeof data.snapshotId !== "string") {
    throw new RuntimeRequestError("protocol", "result data.snapshotId is not a string");
  }
  if (data.pageInfo !== undefined) validatePageInfo(data.pageInfo);
  if (data.networkCapture !== undefined) validateNetworkCapture(data.networkCapture);
  for (const key of ["profiles", "groups", "tabs", "candidates", "logs", "images", "artifacts"] as const) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new RuntimeRequestError("protocol", `result data.${key} is not an array`);
    }
  }
  if (Array.isArray(data.logs)) {
    for (const line of data.logs) {
      if (typeof line !== "string") {
        throw new RuntimeRequestError("protocol", "result data.logs contains a non-string entry");
      }
    }
  }
  if (Array.isArray(data.images)) {
    for (const img of data.images) {
      if (!isRecord(img) || typeof img.data !== "string" || typeof img.mimeType !== "string") {
        throw new RuntimeRequestError("protocol", "result data.images entry is missing data/mimeType");
      }
      if (img.data.length > MAX_IMAGE_BASE64_BYTES) {
        throw new RuntimeRequestError("protocol", `result image exceeds ${MAX_IMAGE_BASE64_BYTES} base64 bytes`);
      }
    }
  }
  if (Array.isArray(data.artifacts)) {
    for (const art of data.artifacts) {
      if (!isRecord(art) || typeof art.path !== "string" || typeof art.mimeType !== "string") {
        throw new RuntimeRequestError("protocol", "result data.artifacts entry is missing path/mimeType");
      }
    }
  }
  if (Array.isArray(data.profiles)) data.profiles.forEach(validateProfile);
}

/**
 * Validate a POST /request body. Business failures (`ok:false`) are considered
 * a valid protocol response and returned as-is; the caller decides whether to
 * throw. Transport-level malformations throw `protocol`.
 */
function validateResponse(value: unknown, expectedRequestId: string): BrowserResponse {
  if (!isRecord(value)) {
    throw new RuntimeRequestError("protocol", "runtime response is not an object");
  }
  if (typeof value.requestId !== "string") {
    throw new RuntimeRequestError("protocol", "runtime response is missing requestId");
  }
  if (value.requestId !== expectedRequestId) {
    throw new RuntimeRequestError(
      "protocol",
      `runtime response requestId ${value.requestId} does not match request ${expectedRequestId}`,
    );
  }
  if (value.ok === true) {
    if (!isRecord(value.data)) {
      throw new RuntimeRequestError("protocol", "successful runtime response is missing data");
    }
    validateResultData(value.data);
    return value as BrowserResponse;
  }
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string") {
      throw new RuntimeRequestError("protocol", "failed runtime response is missing error code/message");
    }
    if (error.outcome !== "not-started" && error.outcome !== "unknown") {
      throw new RuntimeRequestError("protocol", "failed runtime response has an invalid outcome");
    }
    return value as BrowserResponse;
  }
  throw new RuntimeRequestError("protocol", "runtime response is missing a boolean ok field");
}

// --- client -------------------------------------------------------------------

export type RequestOptions = {
  requestId: string;
  sessionId: string;
  operation: BrowserOperation;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class BrowserRuntimeClient {
  readonly config: RuntimeClientConfig;

  constructor(config: RuntimeClientConfig = resolveRuntimeConfig()) {
    this.config = config;
  }

  /** GET /browser/v1/capabilities. */
  async getCapabilities(signal?: AbortSignal): Promise<BrowserCapabilities> {
    const endpoint = "/browser/v1/capabilities";
    // The whole exchange — fetch, non-2xx mapping, and body read/validation — is
    // inside the boundary so a stream that aborts mid-body (headers already in)
    // is classified as a timeout, not a raw AbortError. This is a read, so no
    // outcome is attached (never a business "unknown").
    try {
      const res = await fetch(`${this.config.baseUrl}${endpoint}`, {
        headers: authHeaders(this.config),
        signal: withTimeout(3000, signal),
      });
      if (!res.ok) throw await httpError(res, endpoint);
      return validateCapabilities(await readJson(res));
    } catch (e) {
      throw toTransportError(e, endpoint, this.config.baseUrl, { signal });
    }
  }

  /** GET /browser/v1/profiles. Connection metadata; not filtered by session. */
  async listProfiles(signal?: AbortSignal): Promise<BrowserProfile[]> {
    const endpoint = "/browser/v1/profiles";
    try {
      const res = await fetch(`${this.config.baseUrl}${endpoint}`, {
        headers: authHeaders(this.config),
        signal: withTimeout(5000, signal),
      });
      if (!res.ok) throw await httpError(res, endpoint);
      const body = await readJson(res);
      if (!isRecord(body) || !Array.isArray(body.profiles)) {
        throw new RuntimeRequestError("protocol", "profiles response is missing a profiles array");
      }
      return body.profiles.map(validateProfile);
    } catch (e) {
      throw toTransportError(e, endpoint, this.config.baseUrl, { signal });
    }
  }

  /**
   * POST /browser/v1/request. Returns the runtime data on success. On an
   * `ok:false` operation failure it throws a RuntimeRequestError carrying the
   * runtime's own code/outcome. Transport failures throw as well.
   */
  async request(opts: RequestOptions): Promise<BrowserResultData> {
    const response = await this.requestRaw(opts);
    if (response.ok) return response.data;
    throw new RuntimeRequestError("operation", response.error.message, {
      code: response.error.code,
      outcome: response.error.outcome,
    });
  }

  /** POST /browser/v1/request returning the validated envelope (never throws on ok:false). */
  async requestRaw(opts: RequestOptions): Promise<BrowserResponse> {
    const endpoint = "/browser/v1/request";
    const timeoutMs = clampTimeout(opts.timeoutMs);
    // The operation deadline the runtime enforces and the transport deadline
    // this client enforces are deliberately different: the transport waits one
    // bounded grace past the operation deadline so a typed server timeout can
    // arrive. A user abort is independent of both (see withTimeout).
    const abortBudgetMs = (timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) + TRANSPORT_RESPONSE_GRACE_MS;
    const body: BrowserRequest = {
      requestId: opts.requestId,
      sessionId: opts.sessionId,
      operation: opts.operation,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    // The ENTIRE exchange is inside the boundary: fetch, non-2xx body read, and
    // success body read/validation. Once the POST body is on the wire the page
    // action may already be running, so ANY failure past that point — including
    // a stream that aborts mid-body or an errorBody read that is cut off — must
    // surface outcome "unknown" (mutating:true) rather than a raw AbortError.
    // Protocol/HTTP errors already carry their own semantics and pass through.
    try {
      const res = await fetch(`${this.config.baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(this.config) },
        body: JSON.stringify(body),
        signal: withTimeout(abortBudgetMs, opts.signal),
      });
      if (!res.ok) throw await httpError(res, endpoint);
      return validateResponse(await readJson(res), opts.requestId);
    } catch (e) {
      throw toTransportError(e, endpoint, this.config.baseUrl, { mutating: true, signal: opts.signal });
    }
  }

  /**
   * Best-effort cancellation via a SEPARATE request.cancel operation. Uses a
   * fresh short deadline (never the already-aborted signal) and swallows
   * failures — cancellation is advisory and page actions are never replayed.
   */
  async cancel(options: { sessionId: string; requestId: string; targetRequestId: string }): Promise<void> {
    try {
      await this.requestRaw({
        requestId: options.requestId,
        sessionId: options.sessionId,
        operation: { kind: "request.cancel", targetRequestId: options.targetRequestId },
        timeoutMs: 5000,
      });
    } catch {
      // Advisory: the runtime may already have finished or dropped the request.
    }
  }
}

/** Clamp a caller-provided timeout into the runtime's accepted range. */
export function clampTimeout(timeoutMs?: number): number | undefined {
  if (timeoutMs == null) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.min(Math.floor(timeoutMs), MAX_REQUEST_TIMEOUT_MS);
}

/** Combine a local timeout with an optional caller signal. */
function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any([timeout, signal]);
}
