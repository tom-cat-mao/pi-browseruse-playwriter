/**
 * Pi Browser Use tools — managed runtime edition.
 *
 * These tools drive the user's real Chrome through the paired managed browser
 * runtime (`@tom-cat/pi-browser-runtime`, default 127.0.0.1:19989) over the
 * frozen HTTP v1 contract (playwriter/src/browser-protocol.ts). They only
 * execute and report facts — the Pi LLM owns every decision. There is NO agent
 * loop, HITL, captcha, danger-confirmation, or retry/replay logic here.
 *
 * Contract rules baked into this file (docs/exec/browser-runtime-contract.md):
 *   - Identity: sessionId is the full Pi session UUID, read fresh per request
 *     from ctx.sessionManager.getSessionId() (never an LLM parameter, never a
 *     module-global). requestId is the Pi toolCallId, so a retried/duplicate
 *     create with the same id returns the original resource (dedup by A/B).
 *   - Resources: one Pi session : N named groups; each group is bound to one
 *     fixed profileId. groups.create needs name+profileId; tabs.create needs
 *     groupId+url. All page ops take an explicit tabId. There is no implicit
 *     "current page" and no URL/name matching to reach other sessions' groups.
 *   - groups.list / tabs.list are filtered by the runtime strictly by session.
 *   - Selectors: plain CSS/role selectors are matched strictly (the runtime
 *     never falls back to .first()). aria refs (aria-ref=eN / @eN) require the
 *     snapshotId they came from.
 *   - Cancellation: on abort we fire a separate best-effort request.cancel with
 *     a fresh signal; page actions are never replayed. An already-started action
 *     that is cancelled/timed out is reported with its runtime outcome.
 *   - session_shutdown calls session.release only (frees workers/CDP clients);
 *     it never deletes groups/tabs or changes persistent ownership.
 *   - /browser-status only inspects; it never creates a session/group/tab.
 *   - Output is bounded: text is truncated and only a small number of images
 *     are inlined. No console-marker parsing — results come as structured
 *     BrowserResultData.
 *
 * Human-facing rows: the folded view shows the observed page (title/domain)
 * plus the action, counts and verifiable outcome; opaque ids stay complete in
 * model-visible content and in the expanded detail (the folded fallback is a
 * short id tail). Raw terminal control sequences are stripped before any
 * shortening. Page context is cached per Pi session, bounded, from runtime
 * observations only — never an extra browser call.
 *
 * browser_tabs discover paginates LOCALLY (offset/limit are Pi-only schema
 * fields): the full tabs.discover response is sorted active-first and paged
 * after the response, so no unknown field is ever sent to the runtime, and
 * nextOffset always counts the candidates actually returned.
 *
 * The headless-only `browser_save_as_pdf` tool is intentionally gone: it always
 * errored on headed extension sessions, so it is not registered.
 */

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  BrowserGroup,
  BrowserNetworkCaptureMetadata,
  BrowserOperation,
  BrowserPageInfo,
  BrowserProfile,
  BrowserResultData,
  BrowserTab,
  BrowserTabCandidate,
} from "@tom-cat/pi-browser-runtime/browser-protocol";
import * as runtime from "./bootstrap.ts";
import { RuntimeRequestError } from "./runtime-client.ts";
import {
  byteLen,
  clampBytes,
  pageLabel,
  preview,
  safeStringify,
  shortId,
  sliceToBytes,
  stripTerminalControls,
} from "./ui-format.ts";
import {
  bindResultSession,
  boundResultSession,
  PageContextStore,
  type ObservedPage,
} from "./page-context.ts";

type Json = Record<string, unknown>;
type RenderCallParams = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>;
type RenderResultParams = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>;
type Theme = RenderCallParams[1];
type RenderResultContext = RenderResultParams[3];
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// Output caps so a huge page never overflows the LLM context. Budgets are in
// UTF-8 BYTES (not chars) so multibyte content — e.g. thousands of Chinese
// group names — is measured at its true size, and include truncation markers.
const MAX_INLINE_IMAGES = 2;
const MAX_INLINE_IMAGE_BASE64 = 16 * 1024 * 1024; // ~12MB raw per image
const MAX_TEXT_BYTES = 48_000; // primary page text
const MAX_STRUCTURED_BYTES = 24_000; // budget for the structured-ids JSON block
const MAX_LOG_LINES = 50; // most recent N log lines
const MAX_LOG_BYTES = 20_000; // total bytes across surfaced log lines
// Per-field clamp for free-form display strings (group name, tab url/title,
// profile label) inside the structured block, so one huge value can't blow the
// budget and force JSON slicing that would drop stable ids.
const MAX_FIELD_BYTES = 2_000;
// Hard ceiling on the total text we emit into `content` (excludes image bytes).
// Structured ids are laid down first and are never dropped for text/logs.
const MAX_TOTAL_TEXT_BYTES = 90_000;
// Bounds for the expanded human detail; ids are printed first and always kept.
const MAX_DETAIL_BYTES = 16_000;
const MAX_DETAIL_ITEMS = 10;
const MAX_DETAIL_TEXT_BYTES = 4_000;
const MAX_DETAIL_LOGS_BYTES = 3_000;
const MAX_DETAIL_LOG_LINES = 20;
const MAX_RENDER_ARG_BYTES = 4_000;

// --- optional result metadata (frozen protocol fields) -----------------------

/** Capture lifecycle states as published by the frozen protocol. */
const NETWORK_CAPTURE_STATUSES: readonly string[] = ["active", "stopped", "interrupted", "not-started"];
// Counts are display facts only; this ceiling keeps a malformed/hostile number
// from becoming an absurd UI value (the wire shape is validated by the client).
const MAX_CAPTURE_COUNT = 10_000_000;

/** Pi-only pagination report for browser_tabs discover. */
type DiscoverPage = {
  total: number;
  offset: number;
  returned: number;
  nextOffset: number | null;
  truncated: boolean;
};

/** Everything a human-facing row needs, derived without extra browser calls. */
type ResultView = {
  args: Json;
  details: Json;
  page?: ObservedPage;
  text?: string;
  value?: unknown;
  discover?: DiscoverPage;
  network?: BrowserNetworkCaptureMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bounded copy of an optional `data.pageInfo` observation (frozen protocol).
 * Strings are control-stripped and clamped so a hostile/huge value cannot
 * bloat UI state; the full value still reaches the model through content.
 */
function readPageInfo(value: unknown): BrowserPageInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.tabId !== "string" || typeof value.url !== "string") return undefined;
  const tabId = stripTerminalControls(value.tabId).trim();
  if (!tabId) return undefined;
  return {
    tabId: clampBytes(tabId, MAX_FIELD_BYTES),
    url: clampBytes(stripTerminalControls(value.url), MAX_FIELD_BYTES),
    ...(typeof value.title === "string"
      ? { title: clampBytes(stripTerminalControls(value.title), MAX_FIELD_BYTES) }
      : {}),
  };
}

/**
 * Bounded copy of an optional `data.networkCapture` metadata object (frozen
 * protocol). `status`/counts were validated by the client; this re-guards the
 * UI-only copies and clamps display strings.
 */
function readNetworkCapture(value: unknown): BrowserNetworkCaptureMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (typeof status !== "string" || !NETWORK_CAPTURE_STATUSES.includes(status)) return undefined;
  const retained = value.retainedCount;
  const dropped = value.droppedCount;
  if (typeof retained !== "number" || !Number.isFinite(retained) || retained < 0) return undefined;
  if (typeof dropped !== "number" || !Number.isFinite(dropped) || dropped < 0) return undefined;
  return {
    status: status as BrowserNetworkCaptureMetadata["status"],
    retainedCount: Math.min(Math.floor(retained), MAX_CAPTURE_COUNT),
    droppedCount: Math.min(Math.floor(dropped), MAX_CAPTURE_COUNT),
    ...(typeof value.captureId === "string" && value.captureId
      ? { captureId: clampBytes(stripTerminalControls(value.captureId), 256) }
      : {}),
    ...(typeof value.reason === "string" && value.reason
      ? { reason: clampBytes(stripTerminalControls(value.reason), 512) }
      : {}),
  };
}

/** Validate the Pi-only discover pagination report stored in details. */
function isDiscoverPage(value: unknown): value is DiscoverPage {
  if (!isRecord(value)) return false;
  return (
    typeof value.total === "number" &&
    typeof value.offset === "number" &&
    typeof value.returned === "number" &&
    (typeof value.nextOffset === "number" || value.nextOffset === null) &&
    typeof value.truncated === "boolean"
  );
}

/** Compact projection of capture metadata for the structured (model) block. */
function compactNetworkCapture(meta: BrowserNetworkCaptureMetadata): Json {
  const out: Json = {
    status: meta.status,
    retainedCount: meta.retainedCount,
    droppedCount: meta.droppedCount,
  };
  if (meta.captureId) out.captureId = meta.captureId;
  if (meta.reason) out.reason = meta.reason;
  return out;
}

/** One-line capture summary for model-visible content. */
function networkCaptureLine(meta: BrowserNetworkCaptureMetadata): string {
  const parts = [`status=${meta.status}`, `retained=${meta.retainedCount}`, `dropped=${meta.droppedCount}`];
  if (meta.captureId) parts.push(`captureId=${meta.captureId}`);
  if (meta.reason) parts.push(`reason=${preview(meta.reason, 120)}`);
  return `network capture: ${parts.join(" ")}`;
}

/**
 * Capture summary for the legacy `value` shapes when no metadata is present:
 * list returns a bare array, stop returns an object carrying `entries`.
 * Counts are real observations, never an invented status.
 */
function legacyNetworkCaptureLine(value: unknown): string | undefined {
  if (Array.isArray(value)) return `network capture: ${value.length} request(s) listed`;
  if (isRecord(value) && Array.isArray(value.entries)) {
    const captureId = typeof value.captureId === "string" ? preview(value.captureId, 64) : undefined;
    return `network capture: ${value.entries.length} request(s) retained${captureId ? ` captureId=${captureId}` : ""}`;
  }
  return undefined;
}

// --- rendering helpers -------------------------------------------------------

const DISCOVER_DEFAULT_LIMIT = 20;
const MAX_DISCOVER_LIMIT = 200;
// Soft per-page byte budget for paginated discover candidates. Well below
// MAX_STRUCTURED_BYTES so the structured block never has to truncate the page
// again (which would make nextOffset lie about what was returned).
const DISCOVER_PAGE_BYTES = 16_000;

/** Pretty JSON clamped to a byte budget, stripped of terminal controls. */
function boundedJson(value: unknown, maxBytes: number): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  return clampBytes(stripTerminalControls(json), maxBytes);
}

/** Expand affordance; a renderer must never throw just because no theme is up. */
function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to inspect output");
  } catch {
    return "(ctrl+o to inspect output)";
  }
}

function makeRenderCall(label: string, summarize: (args: Json) => string) {
  return (rawArgs: object, theme: Theme, context: { expanded: boolean }) => {
    const args = (rawArgs ?? {}) as Json;
    const title = theme.fg("toolTitle", theme.bold(label));
    // Expanded shows the bounded call arguments (ids, selectors, values) —
    // never an unbounded code/value dump, and never raw control sequences.
    const body = context.expanded ? boundedJson(args, MAX_RENDER_ARG_BYTES) : summarize(args);
    if (!body) return new Text(title, 0, 0);
    return new Text(`${title}\n${theme.fg(context.expanded ? "muted" : "dim", body)}`, 0, 0);
  };
}

/** Compact one-line description of a runtime error for the LLM. */
function describeError(e: unknown): string {
  if (e instanceof RuntimeRequestError) {
    const parts = [stripTerminalControls(e.message)];
    if (e.code) parts.push(`code=${e.code}`);
    if (e.outcome) parts.push(`outcome=${e.outcome}`);
    return parts.join(" · ");
  }
  return stripTerminalControls(e instanceof Error ? e.message : String(e));
}

// --- extension factory -------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const text = (t: string): ContentBlock => ({ type: "text", text: t });

  /**
   * Run one runtime operation and shape its result into tool content. This is
   * the single choke point: it launches the runtime on first use, injects the
   * per-request sessionId + toolCallId, and on cancellation fires a separate
   * best-effort cancel (never replaying the action).
   */
  async function run(options: {
    ctx: ExtensionContext;
    toolCallId: string;
    signal: AbortSignal | undefined;
    operation: BrowserOperation;
    timeoutMs?: number;
    /**
     * Local post-processing of a successful response (e.g. Pi-only pagination
     * of a full discover list). Runs before shaping, so nextOffset/reporting
     * always describes exactly what the model receives.
     */
    refine?: (data: BrowserResultData) => { data: BrowserResultData; extraDetails?: Json };
  }): Promise<{ content: ContentBlock[]; details: Json }> {
    // If the caller already cancelled, do not even launch the runtime.
    if (options.signal?.aborted) {
      throw new Error("request cancelled before it started");
    }
    // Launch/probe the shared runtime, but let THIS caller bail if it cancels
    // mid-launch — without killing the shared launch other callers may await.
    await runtime.ensureRuntime(options.signal);
    // A cancel that landed during launch must stop us before we send a request.
    if (options.signal?.aborted) {
      throw new Error("request cancelled before it started");
    }
    const client = runtime.getClient();
    const sessionId = runtime.sessionId(options.ctx);
    const requestId = options.toolCallId;

    let data: BrowserResultData;
    try {
      data = await client.request({
        requestId,
        sessionId,
        operation: options.operation,
        cwd: options.ctx.cwd,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    } catch (e) {
      // On ANY timeout — whether the caller aborted or our own deadline fired —
      // ask the runtime to cancel this request with a fresh (non-aborted)
      // signal. Best-effort; the action is never replayed.
      if (e instanceof RuntimeRequestError && e.category === "timeout") {
        await client.cancel({ sessionId, requestId: `${requestId}:cancel`, targetRequestId: requestId });
      }
      // If the daemon went away, drop cached process state so a later tool call
      // re-probes/relaunches instead of failing forever against a dead runtime.
      if (e instanceof RuntimeRequestError && e.category === "runtime-unreachable") {
        runtime.reset();
      }
      throw new Error(describeError(e), { cause: e });
    }

    const pageResult = options.refine ? options.refine(data) : undefined;
    if (pageResult) data = pageResult.data;
    return shapeResult(options.ctx, data, sessionId, pageResult?.extraDetails, options.operation.kind);
  }

  /**
   * Turn BrowserResultData into content blocks + details, applying output caps.
   *
   * CRITICAL: Pi only feeds tool `content` back to the LLM — `details` is UI-only
   * and never enters the model context. So every structured resource the model
   * needs to continue (groupId/tabId from create, snapshotId + refs, evaluate
   * value, listing ids) MUST be serialized into a compact text block here, not
   * left in details. details carries the same data (plus counts) for the TUI.
   */
  function shapeResult(
    ctx: ExtensionContext,
    data: BrowserResultData,
    sessionId: string | undefined,
    extraDetails?: Json,
    operationKind?: BrowserOperation["kind"],
  ): { content: ContentBlock[]; details: Json } {
    const content: ContentBlock[] = [];
    // Optional runtime observations (frozen protocol fields) are copied with
    // bounded validation; they never replace or reshape `value`.
    const pageInfo = readPageInfo(data.pageInfo);
    const networkCapture = readNetworkCapture(data.networkCapture);
    // Remember every page fact the runtime already gave us so later rows can
    // show a title/domain without issuing any extra browser call. Keyed by the
    // Pi session; bounded per session.
    observePage(sessionId, pageInfo);
    if (data.tab) observePage(sessionId, { tabId: data.tab.tabId, url: data.tab.url, title: data.tab.title });
    if (data.tabs) for (const tab of data.tabs) observePage(sessionId, { tabId: tab.tabId, url: tab.url, title: tab.title });
    // Track the running text budget in UTF-8 BYTES so the total content never
    // blows past MAX_TOTAL_TEXT_BYTES regardless of multibyte content. Structured
    // ids are laid down FIRST and always fit (bounded by MAX_STRUCTURED_BYTES) so
    // groupId/tabId/snapshotId can never be pushed out by a large snapshot body
    // or a wall of logs.
    let remaining = MAX_TOTAL_TEXT_BYTES;
    const pushText = (t: string): void => {
      if (!t || remaining <= 0) return;
      const bytes = byteLen(t);
      if (bytes <= remaining) {
        content.push(text(t));
        remaining -= bytes;
        return;
      }
      const marker = "\n…[truncated]";
      const markerBytes = byteLen(marker);
      // Never emit a marker that would itself push us past the budget: if the
      // remaining room can't hold the marker, fill it with text only.
      if (remaining <= markerBytes) {
        content.push(text(sliceToBytes(t, remaining)));
      } else {
        content.push(text(`${sliceToBytes(t, remaining - markerBytes)}${marker}`));
      }
      remaining = 0;
    };

    // 1) Structured resources (ids/value) — highest priority, compact JSON.
    // Optional capture metadata rides along in the same always-kept block.
    const structured = buildStructuredText(data, networkCapture);
    if (structured) pushText(structured);

    // 2) Primary text (snapshot/navigate/etc.), truncated to its own cap first.
    const textTruncated = data.text != null && byteLen(data.text) > MAX_TEXT_BYTES;
    if (data.text) pushText(textTruncated ? `${sliceToBytes(data.text, MAX_TEXT_BYTES)}\n…[truncated]` : data.text);

    // 2b) Capture state/count line. Prefer the optional metadata; fall back to
    // the legacy value shapes (list = array, stop = object with entries) so an
    // older runtime still reports retained counts instead of a bare "ok". The
    // legacy fallback is gated to network operations: an evaluate/execute
    // value can also be an array or object and is not a capture.
    const captureLine = networkCapture
      ? networkCaptureLine(networkCapture)
      : operationKind === "page.network"
        ? legacyNetworkCaptureLine(data.value)
        : undefined;
    if (captureLine) pushText(`\n${captureLine}`);

    // 3) Page logs — last N lines, capped in total bytes.
    let logTruncated = false;
    if (data.logs && data.logs.length > 0) {
      const tail = data.logs.slice(-MAX_LOG_LINES);
      let joined = tail.join("\n");
      if (tail.length < data.logs.length) logTruncated = true;
      if (byteLen(joined) > MAX_LOG_BYTES) {
        joined = sliceToBytes(joined, MAX_LOG_BYTES);
        logTruncated = true;
      }
      pushText(`\nPage logs:\n${joined}`);
    }

    // 4) Artifact paths (small).
    if (data.artifacts && data.artifacts.length > 0) {
      pushText(`\nartifacts: ${data.artifacts.map((a) => `${a.path} (${a.mimeType})`).join(", ")}`);
    }

    const canSee = ctx.model?.input?.includes("image") ?? false;
    let inlined = 0;
    if (canSee && data.images) {
      for (const img of data.images.slice(0, MAX_INLINE_IMAGES)) {
        if (img.data.length <= MAX_INLINE_IMAGE_BASE64) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
          inlined++;
        }
      }
    }
    if (content.length === 0) content.push(text("(no output)"));

    const details: Json = {
      text: data.text,
      value: data.value,
      profiles: data.profiles,
      groups: data.groups,
      tabs: data.tabs,
      candidates: data.candidates,
      group: data.group,
      tab: data.tab,
      snapshotId: data.snapshotId,
      artifacts: data.artifacts,
      logs: data.logs,
      imageCount: data.images?.length ?? 0,
      imagesInlined: inlined,
      textTruncated,
      logTruncated,
      ...(pageInfo ? { pageInfo } : {}),
      ...(networkCapture ? { networkCapture: compactNetworkCapture(networkCapture) } : {}),
      ...(extraDetails ?? {}),
    };
    // Link the UI-only result object to its session so renderers can look up
    // the page context without ever crossing sessions (WeakMap; never stored).
    bindResultSession(details, sessionId ?? "");
    return { content, details };
  }

  /**
   * Serialize the structured fields the LLM must see (ids, snapshotId, evaluate
   * value) as JSON, bounded by MAX_STRUCTURED_BYTES (UTF-8 bytes, not chars).
   *
   * Guarantees:
   *   - the emitted ids block is always VALID parseable JSON, never sliced;
   *   - snapshotId and single group/tab are always kept intact;
   *   - a large list (groups/tabs/profiles) is truncated item-by-item with a
   *     `truncated` count so the JSON stays within budget instead of dumping the
   *     full giant array;
   *   - only the free-form evaluate `value` may be large: if it won't fit it is
   *     emitted separately as an explicitly-truncated string (never sliced JSON).
   * Returns "" when there is nothing structured.
   */
  function buildStructuredText(data: BrowserResultData, networkCapture?: BrowserNetworkCaptureMetadata): string {
    // Small ids that must always survive intact.
    const base: Json = {};
    if (data.snapshotId) base.snapshotId = data.snapshotId;
    if (data.group) base.group = compactGroup(data.group);
    if (data.tab) base.tab = compactTab(data.tab);
    // Capture metadata is a few bytes and must never be dropped: it is the
    // difference between "0 requests" and "capture was interrupted".
    if (networkCapture) base.networkCapture = compactNetworkCapture(networkCapture);

    // Lists are budgeted: keep as many items as fit, record how many dropped.
    const lists: Array<{ key: "profiles" | "groups" | "tabs" | "candidates"; items: Json[] }> = [];
    if (data.profiles) lists.push({ key: "profiles", items: data.profiles.map(compactProfile) });
    if (data.groups) lists.push({ key: "groups", items: data.groups.map(compactGroup) });
    if (data.tabs) lists.push({ key: "tabs", items: data.tabs.map(compactTab) });
    if (data.candidates) lists.push({ key: "candidates", items: data.candidates.map(compactCandidate) });

    // Fast path: everything (base + full lists + value) fits.
    const full: Json = { ...base };
    for (const l of lists) full[l.key] = l.items;
    if (data.value !== undefined) full.value = data.value;
    if (Object.keys(full).length === 0) return "";
    const fullJson = JSON.stringify(full);
    if (byteLen(fullJson) <= MAX_STRUCTURED_BYTES) return fullJson;

    // Over budget. Rebuild with bounded lists, reserving room for the value.
    const out: Json = { ...base };
    const valueStr =
      data.value === undefined ? undefined : typeof data.value === "string" ? data.value : JSON.stringify(data.value);
    // Reserve up to a quarter of the budget for a value preview (emitted outside
    // the JSON) so ids/lists get the rest.
    const listBudget = valueStr !== undefined ? Math.floor(MAX_STRUCTURED_BYTES * 0.75) : MAX_STRUCTURED_BYTES;
    // Reserve room UPFRONT for EVERY list's empty-array key and its worst-case
    // `${key}Truncated:<count>` marker. Packing one list to the full budget and
    // only then discovering the other lists' keys/markers still need bytes would
    // overflow — a single-list test never catches this.
    const overhead = lists.reduce(
      (sum, l) => sum + byteLen(`,"${l.key}":[]`) + byteLen(`,"${l.key}Truncated":${l.items.length}`),
      0,
    );
    const packBudget = Math.max(0, listBudget - overhead);
    for (const l of lists) {
      const kept: Json[] = [];
      for (const item of l.items) {
        kept.push(item);
        if (byteLen(JSON.stringify({ ...out, [l.key]: kept })) > packBudget) {
          kept.pop();
          break;
        }
      }
      out[l.key] = kept;
      const dropped = l.items.length - kept.length;
      if (dropped > 0) out[`${l.key}Truncated`] = dropped;
    }
    const idsJson = JSON.stringify(out);

    if (valueStr === undefined) return idsJson;
    // value present and the whole thing didn't fit: emit ids JSON, then the
    // value as an explicitly-truncated standalone string (never sliced JSON).
    // Compute the value block's real header/footer byte cost (no magic number)
    // so the whole structured block stays within MAX_STRUCTURED_BYTES.
    const header = `\nvalue (truncated, ${valueStr.length} chars total):\n`;
    const footer = "\n…[value truncated; read it in smaller pieces via browser_evaluate]";
    const valueBudget = Math.max(0, MAX_STRUCTURED_BYTES - byteLen(idsJson) - byteLen(header) - byteLen(footer));
    const valuePreview = sliceToBytes(valueStr, valueBudget);
    const valueBlock = `${header.slice(1)}${valuePreview}${footer}`;
    return Object.keys(out).length > 0 ? `${idsJson}\n${valueBlock}` : valueBlock;
  }

  // Compact projections keep only the fields the LLM needs to act. Stable IDs
  // are kept intact; free-form display fields (name/url/title/label) are clamped
  // to MAX_FIELD_BYTES so a single resource with a huge title/url can never make
  // the structured block exceed its byte budget and force JSON slicing that
  // would drop the ids. Keeping an id != keeping an unbounded name.
  const clampField = (s: string | undefined): string => {
    if (s == null) return "";
    const clean = stripTerminalControls(s);
    if (byteLen(clean) <= MAX_FIELD_BYTES) return clean;
    return `${sliceToBytes(clean, MAX_FIELD_BYTES)}…`;
  };
  const compactGroup = (g: BrowserGroup): Json => ({
    groupId: g.groupId,
    name: clampField(g.name),
    profileId: g.profileId,
    state: g.state,
  });
  const compactTab = (t: BrowserTab): Json => ({
    tabId: t.tabId,
    groupId: t.groupId,
    url: clampField(t.url),
    title: clampField(t.title),
    state: t.state,
    ...(t.sourceTabId ? { sourceTabId: t.sourceTabId } : {}),
    ...(t.origin ? { origin: t.origin } : {}),
  });
  // A discovered existing tab: everything needed to decide which one the user
  // means, without reading any page content.
  const compactCandidate = (c: BrowserTabCandidate): Json => ({
    candidateId: c.candidateId,
    title: clampField(c.title),
    url: clampField(c.url),
    profileId: c.profileId,
    profileLabel: clampField(c.profileLabel),
    browser: clampField(c.browser),
    windowId: c.windowId,
    active: c.active,
    windowFocused: c.windowFocused,
    managed: c.managed,
    attachable: c.attachable,
    ...(c.tabId ? { tabId: c.tabId } : {}),
    ...(c.reason ? { reason: c.reason } : {}),
  });
  const compactProfile = (p: BrowserProfile): Json => ({
    profileId: p.profileId,
    label: clampField(p.label),
    browser: p.browser,
    connected: p.connected,
  });

  // --- human-facing result rows ---------------------------------------------
  //
  // The folded view shows page/domain + action + verifiable counts. Opaque ids
  // stay complete in model-visible content and in the expanded detail; folded
  // falls back to a short id tail only when nothing human is known. The page
  // context comes exclusively from data the runtime already returned.

  const pageContext = new PageContextStore();

  const observePage = (sessionId: string | undefined, page: ObservedPage | undefined): void => {
    if (page) pageContext.observe(sessionId, page);
  };

  function makeResultView(args: Json, details: Json): ResultView {
    const sessionId = boundResultSession(details);
    const pageInfo = readPageInfo(details.pageInfo);
    const tab = isRecord(details.tab) ? details.tab : undefined;
    const tabId = typeof tab?.tabId === "string" ? tab.tabId : args.tabId;
    const fromTab: ObservedPage | undefined =
      tab && typeof tab.tabId === "string" && typeof tab.url === "string"
        ? { tabId: tab.tabId, url: tab.url, ...(typeof tab.title === "string" ? { title: tab.title } : {}) }
        : undefined;
    const page = pageInfo ?? fromTab ?? pageContext.lookup(sessionId, tabId);
    const discover = isDiscoverPage(details.discover) ? details.discover : undefined;
    const network = readNetworkCapture(details.networkCapture);
    return {
      args,
      details,
      ...(page ? { page } : {}),
      ...(typeof details.text === "string" ? { text: details.text } : {}),
      ...(details.value !== undefined ? { value: details.value } : {}),
      ...(discover ? { discover } : {}),
      ...(network ? { network } : {}),
    };
  }

  const listCount = (view: ResultView, key: string): number => {
    const value = view.details[key];
    return Array.isArray(value) ? value.length : 0;
  };

  /**
   * Human page suffix for summaries. Falls back to a short id tail when no
   * observed page is known, so a row never loses track of which tab it refers
   * to (the full id stays in content and expanded detail).
   */
  const pageSuffix = (view: ResultView): string => {
    const label = pageLabel(view.page);
    if (label) return ` · ${label}`;
    const id = shortId(view.args.tabId);
    return id ? ` · ${id}` : "";
  };

  /** Number of captured entries in either legacy value shape (array | entries). */
  function capturedEntryCount(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    if (isRecord(value) && Array.isArray(value.entries)) return value.entries.length;
    return 0;
  }

  const isTextBlock = (c: ContentBlock): c is { type: "text"; text: string } => c.type === "text";

  function renderErrorResult(
    result: { content?: ContentBlock[] },
    options: { expanded: boolean },
    theme: Theme,
  ) {
    const raw = (result.content ?? []).filter(isTextBlock).map((c) => c.text).join("\n");
    // Real control bytes are stripped before any shortening, so the error text
    // can never inject terminal state — even in the expanded branch.
    const full = stripTerminalControls(raw || "failed");
    if (options.expanded) {
      const marker = "\n…[error truncated]";
      const body =
        byteLen(full) <= MAX_DETAIL_BYTES
          ? full
          : `${sliceToBytes(full, MAX_DETAIL_BYTES - byteLen(marker))}${marker}`;
      return new Text(theme.fg("error", `✗ ${body}`), 0, 0);
    }
    const first = full.split("\n").find((line) => line.trim()) ?? "failed";
    return new Text(`${theme.fg("error", `✗ ${preview(first, 160)}`)}\n${expandHint()}`, 0, 0);
  }

  /**
   * Bounded expanded detail. Stable opaque ids come first and are never
   * dropped; text/value/logs are byte- and line-capped instead of dumping
   * unbounded raw details.
   */
  function renderResultDetails(view: ResultView): string {
    const lines: string[] = [];
    if (view.page) {
      if (view.page.title) lines.push(`page: ${clampBytes(stripTerminalControls(view.page.title), MAX_FIELD_BYTES)}`);
      lines.push(`url: ${clampBytes(stripTerminalControls(view.page.url), MAX_FIELD_BYTES)}`);
    }
    const ids: string[] = [];
    if (typeof view.details.snapshotId === "string") ids.push(`snapshotId=${view.details.snapshotId}`);
    const tab = isRecord(view.details.tab) ? view.details.tab : undefined;
    const tabId = typeof tab?.tabId === "string" ? tab.tabId : view.args.tabId;
    if (typeof tabId === "string" && tabId) ids.push(`tabId=${tabId}`);
    const group = isRecord(view.details.group) ? view.details.group : undefined;
    if (typeof group?.groupId === "string") ids.push(`groupId=${group.groupId}`);
    if (ids.length) lines.push(`ids: ${ids.join(" · ")}`);
    if (view.network) lines.push(networkCaptureLine(view.network));
    if (view.discover) {
      lines.push(
        `discover: total=${view.discover.total} offset=${view.discover.offset} returned=${view.discover.returned} ` +
          `nextOffset=${view.discover.nextOffset ?? "none"} truncated=${view.discover.truncated}`,
      );
    }
    for (const key of ["groups", "tabs", "profiles", "candidates"]) {
      const value = view.details[key];
      if (Array.isArray(value) && value.length > 0) lines.push(...detailListLines(key, value));
    }
    if (typeof view.details.text === "string" && view.details.text) {
      lines.push("text:", clampBytes(stripTerminalControls(view.details.text), MAX_DETAIL_TEXT_BYTES));
    }
    if (view.value !== undefined) {
      const raw = typeof view.value === "string" ? view.value : safeStringify(view.value);
      lines.push("value:", clampBytes(stripTerminalControls(raw), MAX_DETAIL_TEXT_BYTES));
    }
    if (Array.isArray(view.details.logs) && view.details.logs.length > 0) {
      const tail = view.details.logs.slice(-MAX_DETAIL_LOG_LINES).join("\n");
      lines.push("logs:", clampBytes(stripTerminalControls(tail), MAX_DETAIL_LOGS_BYTES));
    }
    if (Array.isArray(view.details.artifacts)) {
      for (const artifact of view.details.artifacts.slice(0, MAX_DETAIL_ITEMS)) {
        if (isRecord(artifact) && typeof artifact.path === "string") {
          lines.push(`artifact: ${clampBytes(stripTerminalControls(artifact.path), MAX_FIELD_BYTES)}`);
        }
      }
    }
    const joined = lines.join("\n");
    if (byteLen(joined) <= MAX_DETAIL_BYTES) return joined;
    const marker = "\n…[detail truncated]";
    return `${sliceToBytes(joined, MAX_DETAIL_BYTES - byteLen(marker))}${marker}`;
  }

  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  /** One line per list entry with its FULL id, bounded by item count. */
  function detailListLines(key: string, items: unknown[]): string[] {
    const out = [`${key}: ${items.length}`];
    for (const item of items.slice(0, MAX_DETAIL_ITEMS)) {
      if (!isRecord(item)) {
        out.push(`  ${preview(item, 120)}`);
        continue;
      }
      const id = str(item.candidateId) || str(item.tabId) || str(item.groupId) || str(item.profileId);
      const human = str(item.title) || str(item.name) || str(item.label) || str(item.url);
      out.push(`  ${[id, human ? preview(human, 80) : ""].filter(Boolean).join(" ")}`);
    }
    if (items.length > MAX_DETAIL_ITEMS) out.push(`  … ${items.length - MAX_DETAIL_ITEMS} more`);
    return out;
  }

  function makeRenderResult(summarize: (view: ResultView) => string) {
    return (
      result: { details?: unknown; content?: ContentBlock[] },
      options: { expanded: boolean },
      theme: Theme,
      context?: RenderResultContext,
    ) => {
      // On error the framework marks the row; show the real bounded error
      // instead of a misleading "✓". Expanded shows the complete bounded
      // multiline message (code/outcome included), collapsed keeps the first
      // line plus an expand affordance.
      if (context?.isError) return renderErrorResult(result, options, theme);
      const rawDetails = isRecord(result?.details) ? result.details : {};
      const args = isRecord(context?.args) ? context.args : {};
      const view = makeResultView(args, rawDetails);
      if (!options.expanded) {
        const line = summarize(view) || "done";
        return new Text(`${theme.fg("dim", line)}\n${expandHint()}`, 0, 0);
      }
      return new Text(theme.fg("toolOutput", renderResultDetails(view)), 0, 0);
    };
  }

  // --- Pi-only discover pagination ------------------------------------------

  const sortCandidates = (candidates: BrowserTabCandidate[]): BrowserTabCandidate[] =>
    [...candidates].sort(
      (a, b) => Number(b.active) - Number(a.active) || Number(b.windowFocused) - Number(a.windowFocused),
    );

  /**
   * Sort + page a full tabs.discover response locally. `offset`/`limit` are
   * never sent to the runtime. nextOffset always counts the candidates that
   * were actually returned (including a byte-budget cut), so paging cannot
   * skip an unseen entry.
   */
  function paginateDiscover(
    data: BrowserResultData,
    offsetRaw: number | undefined,
    limitRaw: number | undefined,
  ): { data: BrowserResultData; extraDetails: Json } {
    const total = data.candidates?.length ?? 0;
    const sorted = sortCandidates(data.candidates ?? []);
    const offset = Math.max(0, Math.floor(offsetRaw ?? 0));
    const limit = Math.min(Math.max(Math.floor(limitRaw ?? DISCOVER_DEFAULT_LIMIT), 1), MAX_DISCOVER_LIMIT);
    const start = Math.min(offset, total);
    const requested = sorted.slice(start, start + limit);
    const accepted: BrowserTabCandidate[] = [];
    let usedBytes = 0;
    for (const candidate of requested) {
      const cost = byteLen(JSON.stringify(compactCandidate(candidate))) + 1;
      // Always accept the first candidate of the page: a single clamped item
      // fits the structured budget, and an empty page would hide the entry at
      // the requested offset.
      if (accepted.length > 0 && usedBytes + cost > DISCOVER_PAGE_BYTES) break;
      accepted.push(candidate);
      usedBytes += cost;
    }
    const returned = accepted.length;
    const consumed = start + returned;
    const nextOffset = consumed < total ? consumed : null;
    const range = returned === 0 ? "0" : `${start + 1}-${consumed}`;
    const summary =
      `Showing ${range} of ${total} open tab(s) · total=${total} returned=${returned} ` +
      `nextOffset=${nextOffset ?? "none"} truncated=${nextOffset !== null}`;
    return {
      data: { ...data, candidates: accepted, text: data.text ? `${data.text}\n${summary}` : summary },
      extraDetails: { discover: { total, offset: start, returned, nextOffset, truncated: nextOffset !== null } },
    };
  }

  // --- profiles -------------------------------------------------------------

  pi.registerTool({
    name: "browser_profiles",
    label: "Browser Profiles",
    description:
      "List the browser profiles (installed Chrome identities) the managed runtime knows about, with their connection state. " +
      "A profileId is required to create a group. This is connection metadata, not filtered by session.",
    promptSnippet: "List available browser profiles",
    promptGuidelines: [
      "Use browser_profiles to discover a profileId before browser_groups create. A profile must be connected to open groups/tabs in it.",
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      return run({ ctx, toolCallId, signal, operation: { kind: "profiles.list" } });
    },
    renderCall: makeRenderCall("browser profiles", () => ""),
    renderResult: makeRenderResult((view) => {
      const profiles = (view.details.profiles as BrowserProfile[] | undefined) ?? [];
      if (profiles.length === 1) {
        const profile = profiles[0];
        return `✓ ${profile.label} · ${profile.browser} · ${profile.connected ? "connected" : "disconnected"}`;
      }
      const connected = profiles.filter((p) => p.connected).length;
      return `✓ ${profiles.length} profile(s) · ${connected} connected`;
    }),
  });

  // --- groups ---------------------------------------------------------------

  pi.registerTool({
    name: "browser_groups",
    label: "Browser Groups",
    description:
      "Manage this session's tab groups. Each group is owned by this Pi session and bound to one fixed profile. " +
      "Actions: list (this session's groups only), create (needs a name and a profileId), rename, close. " +
      "Same-name groups are allowed — each has its own groupId; there is no merging by title.",
    promptSnippet: "List/create/rename/close this session's tab groups",
    promptGuidelines: [
      "Use browser_groups create with an explicit name and a profileId from browser_profiles before opening tabs; a group is bound to one profile for its lifetime. Use its groupId with browser_tabs create.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "rename", "close"] as const),
      profileId: Type.Optional(Type.String({ description: "For create (required) or to filter list" })),
      name: Type.Optional(Type.String({ description: "For create/rename (required): the group name" })),
      groupId: Type.Optional(Type.String({ description: "For rename/close (required)" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const op = ((): BrowserOperation => {
        if (params.action === "create") {
          if (!params.profileId || !params.name) {
            throw new Error("browser_groups create requires both profileId and name");
          }
          return { kind: "groups.create", profileId: params.profileId, name: params.name };
        }
        if (params.action === "rename") {
          if (!params.groupId || !params.name) {
            throw new Error("browser_groups rename requires both groupId and name");
          }
          return { kind: "groups.rename", groupId: params.groupId, name: params.name };
        }
        if (params.action === "close") {
          if (!params.groupId) throw new Error("browser_groups close requires groupId");
          return { kind: "groups.close", groupId: params.groupId };
        }
        return { kind: "groups.list", ...(params.profileId ? { profileId: params.profileId } : {}) };
      })();
      return run({ ctx, toolCallId, signal, operation: op });
    },
    renderCall: makeRenderCall("browser groups", (a) =>
      `${a.action}${a.name ? ` "${a.name}"` : ""}${a.groupId ? ` [${shortId(a.groupId)}]` : ""}${a.profileId ? ` profile=${shortId(a.profileId)}` : ""}`,
    ),
    renderResult: makeRenderResult((view) => {
      const group = view.details.group as BrowserGroup | undefined;
      if (group) {
        const label = group.name ? `"${group.name}"` : shortId(group.groupId);
        return `✓ group ${label} · ${group.state}`;
      }
      const groups = (view.details.groups as BrowserGroup[] | undefined) ?? [];
      return `✓ ${groups.length} group(s)`;
    }),
  });

  // --- tabs -----------------------------------------------------------------

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description:
      "Work with tabs. Actions: list (this session's tabs, optionally filtered by groupId or by the tab a link was opened " +
      "from), create (needs groupId and url — opens a new tab inside that group), discover (list the real tabs already open " +
      "in the connected browser profiles with their window, title, URL and active state — use it when the user points you at " +
      "a page they are already looking at; results are paginated: active tabs first, then focused windows, and the response " +
      "reports total/returned/nextOffset/truncated), attach (needs candidateId from discover — take control of that existing " +
      "tab where it is, without reloading, moving or regrouping it, and get back a normal tabId), activate (make a tab the " +
      "active tab of its window again after reading a link elsewhere), close, release (relinquish this session's control of " +
      "a tab so a later reconnect won't pull it back into this session). All actions take explicit ids; there is no implicit " +
      "current tab.",
    promptSnippet: "List/create/attach/activate/close/release tabs, or discover the tabs already open",
    promptGuidelines: [
      "When the user says they are looking at a page and want you to continue there, call browser_tabs with action:\"discover\", pick the matching entry by title/URL/window, then action:\"attach\" with its candidateId — you get a normal tabId and keep working in that same tab (nothing is reloaded or moved).",
      "browser_tabs discover returns one page at a time (default 20, ordered active-first). Read the total/returned/nextOffset/truncated line: when truncated=true, call discover again with offset=nextOffset to see the rest — never assume the page contains every open tab.",
      "Use browser_tabs create with a groupId (from browser_groups) and a url to open a managed tab; use the returned tabId for all page tools. Use release to give up control of a tab when you are done with it so a later reconnect won't pull it back into this session.",
      "After a link opens in a new tab, use browser_tabs list with sourceTabId set to the tab you clicked in to find the real new tab, or browser_tabs activate to go back to the original tab. Never guess by URL or by 'the last tab'.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "discover", "attach", "activate", "create", "close", "release"] as const),
      groupId: Type.Optional(Type.String({ description: "For create (required) or to filter list" })),
      url: Type.Optional(Type.String({ description: "For create (required): initial URL" })),
      tabId: Type.Optional(Type.String({ description: "For close/release/activate (required)" })),
      sourceTabId: Type.Optional(Type.String({ description: "For list: only tabs that were opened from this tabId" })),
      candidateId: Type.Optional(Type.String({ description: "For attach (required): a candidateId from discover" })),
      profileId: Type.Optional(Type.String({ description: "For discover: only this profile" })),
      windowId: Type.Optional(Type.Integer({ description: "For discover: only this browser window" })),
      query: Type.Optional(Type.String({ description: "For discover: only tabs whose title or URL contains this text" })),
      includeManaged: Type.Optional(Type.Boolean({ description: "For discover: set false to hide tabs already under this session's control" })),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: "For discover: skip this many candidates (Pi-side pagination; use nextOffset)" }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_DISCOVER_LIMIT,
          description: "For discover: page size (default 20, Pi-side pagination)",
        }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "discover") {
        // offset/limit are Pi-side pagination only: the frozen tabs.discover
        // operation below carries exactly the filters the runtime understands.
        return run({
          ctx,
          toolCallId,
          signal,
          operation: {
            kind: "tabs.discover",
            ...(params.profileId ? { profileId: params.profileId } : {}),
            ...(params.windowId !== undefined ? { windowId: params.windowId } : {}),
            ...(params.query ? { query: params.query } : {}),
            ...(params.includeManaged !== undefined ? { includeManaged: params.includeManaged } : {}),
          },
          refine: (data) => paginateDiscover(data, params.offset, params.limit),
        });
      }
      const op = ((): BrowserOperation => {
        if (params.action === "attach") {
          if (!params.candidateId) throw new Error("browser_tabs attach requires candidateId from discover");
          return { kind: "tabs.attach", candidateId: params.candidateId };
        }
        if (params.action === "activate") {
          if (!params.tabId) throw new Error("browser_tabs activate requires tabId");
          return { kind: "tabs.activate", tabId: params.tabId };
        }
        if (params.action === "create") {
          if (!params.groupId || !params.url) {
            throw new Error("browser_tabs create requires both groupId and url");
          }
          return { kind: "tabs.create", groupId: params.groupId, url: params.url };
        }
        if (params.action === "close") {
          if (!params.tabId) throw new Error("browser_tabs close requires tabId");
          return { kind: "tabs.close", tabId: params.tabId };
        }
        if (params.action === "release") {
          if (!params.tabId) throw new Error("browser_tabs release requires tabId");
          return { kind: "tabs.release", tabId: params.tabId };
        }
        return {
          kind: "tabs.list",
          ...(params.groupId ? { groupId: params.groupId } : {}),
          ...(params.sourceTabId ? { sourceTabId: params.sourceTabId } : {}),
        };
      })();
      return run({ ctx, toolCallId, signal, operation: op });
    },
    renderCall: makeRenderCall("browser tabs", (a) =>
      `${a.action}${a.groupId ? ` group=${shortId(a.groupId)}` : ""}${a.tabId ? ` [${shortId(a.tabId)}]` : ""}${a.candidateId ? ` ${shortId(a.candidateId)}` : ""}${a.query ? ` query="${preview(a.query, 40)}"` : ""}${a.url ? ` ${preview(a.url, 64)}` : ""}${a.offset !== undefined ? ` offset=${a.offset}` : ""}${a.limit !== undefined ? ` limit=${a.limit}` : ""}`,
    ),
    renderResult: makeRenderResult((view) => {
      const discover = view.discover;
      if (discover) {
        const page = discover.truncated ? ` · nextOffset ${discover.nextOffset}` : " · complete";
        return `✓ ${discover.total} open tab(s) · showing ${discover.returned}${page}`;
      }
      const tab = view.details.tab as BrowserTab | undefined;
      if (tab) {
        const verbs: Record<string, string> = {
          create: "created",
          attach: "attached",
          activate: "activated",
          close: "closed",
          release: "released",
        };
        const action = typeof view.args.action === "string" ? view.args.action : "tab";
        const verb = verbs[action] ?? action;
        const label = pageLabel(view.page) || tab.title || shortId(tab.tabId);
        return `✓ ${verb} ${label} · ${tab.state}`;
      }
      const tabs = (view.details.tabs as BrowserTab[] | undefined) ?? [];
      const candidates = (view.details.candidates as BrowserTabCandidate[] | undefined) ?? [];
      if (candidates.length > 0) return `✓ ${candidates.length} open tab(s)`;
      return `✓ ${tabs.length} tab(s)`;
    }),
  });

  // --- page: navigate -------------------------------------------------------

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "Move an existing managed tab (by tabId). Default action \"goto\" navigates to a URL and returns the final URL after " +
      "redirects. action:\"back\" performs a normal browser history back in that same tab — use it when a link changed the page " +
      "you were on and you want the previous page back (it does not reopen or re-navigate the old URL).",
    promptSnippet: "Navigate a managed tab, or go back in its history",
    promptGuidelines: [
      "Use browser_navigate with a tabId from browser_tabs to load a URL, then browser_snapshot to read the page — pages redirect, so always re-check.",
      "Use browser_navigate with action:\"back\" (no url) when a link navigated the tab you were working in; the browser restores the previous history entry (scroll/form state depends on the site — re-snapshot to check). To return to an original tab after reading a link that opened a NEW tab, use browser_tabs action:\"activate\" instead.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      url: Type.Optional(Type.String({ description: "URL to open (required for action \"goto\")" })),
      action: Type.Optional(
        StringEnum(["goto", "back"] as const, { description: "goto (default) or back (browser history)" }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "back") {
        return run({ ctx, toolCallId, signal, operation: { kind: "page.back", tabId: params.tabId } });
      }
      if (!params.url) throw new Error("browser_navigate requires url unless action is \"back\"");
      return run({ ctx, toolCallId, signal, operation: { kind: "page.navigate", tabId: params.tabId, url: params.url } });
    },
    renderCall: makeRenderCall("browser navigate", (a) =>
      a.action === "back" ? `[${shortId(a.tabId)}] back` : `[${shortId(a.tabId)}] goto ${preview(a.url, 72)}`,
    ),
    renderResult: makeRenderResult((view) => {
      const tab = view.details.tab as BrowserTab | undefined;
      const isBack = view.args.action === "back";
      if (isBack) {
        // A history back often has no URL data in the result; the action itself
        // must still be visible instead of an empty "ok".
        const context =
          pageLabel(view.page) ||
          (typeof view.text === "string" ? preview(view.text, 80) : "") ||
          shortId(view.args.tabId);
        return `✓ back${context ? ` · ${context}` : ""}`;
      }
      const url =
        (tab?.url ? pageLabel({ url: tab.url, title: tab.title }) : "") ||
        (typeof view.text === "string" ? preview(view.text, 96) : "") ||
        preview(view.args.url, 96);
      return `✓ goto${url ? ` · ${url}` : pageSuffix(view)}`;
    }),
  });

  // --- page: snapshot -------------------------------------------------------

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Read a managed tab as an accessibility tree with element refs (aria-ref=eN). Primary way to read page content and " +
      "get refs for browser_click/browser_fill. The default tree is the readable page content (text, headings, controls) — " +
      "not interactive-only — so it can be large; narrow it with a text search or a strict CSS selector that matches exactly " +
      "one scope element. full requests the complete unfiltered tree.",
    promptSnippet: "Read a managed tab as an accessibility tree",
    promptGuidelines: [
      "Use browser_snapshot to read a tab's content and obtain aria-ref=eN refs; pass those refs (with the returned snapshotId) to browser_click/browser_fill. Refs are only valid against the snapshot that produced them.",
      "browser_snapshot selector must match exactly one element: zero or multiple matches is an error (there is no implicit .first()) — narrow the selector or use search instead. The default result is the readable whole tree, not only interactive nodes; use search to keep large pages compact.",
      "Any browser_evaluate or browser_execute call conservatively invalidates the latest snapshot, even a read-only one: take a fresh browser_snapshot before using refs again, or the action throws stale-snapshot.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      search: Type.Optional(Type.String({ description: "Only include nodes matching this text" })),
      selector: Type.Optional(Type.String({ description: "Scope the snapshot to a single matching CSS selector" })),
      full: Type.Optional(Type.Boolean({ description: "Return the complete unfiltered tree" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: {
          kind: "page.snapshot",
          tabId: params.tabId,
          ...(params.search ? { search: params.search } : {}),
          ...(params.selector ? { selector: params.selector } : {}),
          ...(params.full ? { full: params.full } : {}),
        },
      });
    },
    renderCall: makeRenderCall("browser snapshot", (a) =>
      `[${shortId(a.tabId)}]${a.selector ? ` selector=${preview(a.selector, 40)}` : ""}${a.search ? ` search=${preview(a.search, 32)}` : ""}${a.full ? " full" : ""}`,
    ),
    renderResult: makeRenderResult((view) => {
      const lines = view.text ? view.text.split("\n").length : 0;
      const refs = isRecord(view.value) && Array.isArray(view.value.refs) ? view.value.refs.length : 0;
      const snapshot = view.details.snapshotId ? ` · ${shortId(view.details.snapshotId)}` : "";
      return `✓ snapshot ${lines} lines${refs ? ` · ${refs} refs` : ""}${snapshot}${pageSuffix(view)}`;
    }),
  });

  // --- page: click ----------------------------------------------------------

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element in a managed tab. Pass either a snapshot ref (aria-ref=eN or @eN) together with the snapshotId it " +
      "came from, or a plain CSS/role selector. Selectors are matched strictly — zero or multiple matches is an error, " +
      "never a guess.",
    promptSnippet: "Click an element by ref or CSS selector",
    promptGuidelines: [
      "Use browser_click with an aria-ref=eN from the latest browser_snapshot plus its snapshotId; if the page changed or you ran browser_evaluate/browser_execute since the snapshot, re-snapshot first (refs are invalidated conservatively). A plain CSS/role selector must match exactly one element: zero or multiple matches is an error.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      selector: Type.String({ description: "aria-ref=eN, @eN, or a strict CSS/role selector" }),
      snapshotId: Type.Optional(Type.String({ description: "Required when selector is an aria ref" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: {
          kind: "page.click",
          tabId: params.tabId,
          selector: params.selector,
          ...(params.snapshotId ? { snapshotId: params.snapshotId } : {}),
        },
      });
    },
    renderCall: makeRenderCall("browser click", (a) => `[${shortId(a.tabId)}] ${preview(a.selector, 72)}`),
    renderResult: makeRenderResult((view) => `✓ clicked${pageSuffix(view)}`),
  });

  // --- page: fill -----------------------------------------------------------

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description:
      "Set text into an input/textarea/contenteditable in a managed tab (clear-and-insert: existing content is replaced). " +
      "Target by snapshot ref (aria-ref=eN / @eN with its snapshotId) or a strict CSS selector that matches exactly one element.",
    promptSnippet: "Fill inputs and rich-text editors",
    promptGuidelines: [
      "Use browser_fill to replace an input's value; to append, read the current value with browser_evaluate, concatenate, then fill. Use an aria ref + snapshotId, or a strict CSS/role selector (zero or multiple matches is an error). Re-snapshot after browser_evaluate/browser_execute before reusing refs.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      selector: Type.String({ description: "aria-ref=eN, @eN, or a strict CSS selector" }),
      value: Type.String({ description: "Text to insert (replaces existing content)" }),
      snapshotId: Type.Optional(Type.String({ description: "Required when selector is an aria ref" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: {
          kind: "page.fill",
          tabId: params.tabId,
          selector: params.selector,
          value: params.value,
          ...(params.snapshotId ? { snapshotId: params.snapshotId } : {}),
        },
      });
    },
    renderCall: makeRenderCall("browser fill", (a) =>
      `[${shortId(a.tabId)}] ${preview(a.selector, 48)} ← "${preview(a.value, 40)}"`,
    ),
    renderResult: makeRenderResult((view) => `✓ filled${pageSuffix(view)}`),
  });

  // --- page: evaluate -------------------------------------------------------

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description:
      "Run JavaScript inside a managed tab's page (document/window available, async/await supported). Returns the " +
      "JSON-serializable result value. Use browser_execute for the Node/Playwright sandbox instead.",
    promptSnippet: "Run JavaScript in a managed tab's page",
    promptGuidelines: [
      "Use browser_evaluate for attributes/scrolling/complex reads a snapshot can't give; it runs in the page (document/window). End with `return <value>` — a bare expression returns undefined. Use browser_execute for Playwright-level control.",
      "browser_evaluate conservatively invalidates the latest browser_snapshot even when it only read data: take a fresh snapshot before the next browser_click/browser_fill that uses a ref.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      code: Type.String({ description: "JS code, async/await supported" }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({ ctx, toolCallId, signal, operation: { kind: "page.evaluate", tabId: params.tabId, code: params.code } });
    },
    renderCall: makeRenderCall("browser evaluate", (a) => `[${shortId(a.tabId)}] ${preview(a.code, 72)}`),
    renderResult: makeRenderResult((view) => {
      const value = view.value !== undefined ? `value: ${preview(view.value, 64)}` : "value: undefined";
      return `✓ ${value}${pageSuffix(view)}`;
    }),
  });

  // --- page: screenshot -----------------------------------------------------

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Screenshot a managed tab. Returns the image inline (when the model can see images) and, if a path is given, saves it. " +
      "Optionally capture the full scrollable page or overlay interactive-element labels.",
    promptSnippet: "Screenshot a managed tab",
    promptGuidelines: [
      "Use browser_screenshot when you need visual/spatial state; browser_snapshot is cheaper for text. Pass a path to save the file, fullPage for the whole page, or labels to overlay element markers.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      path: Type.Optional(Type.String({ description: "Absolute output path" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page" })),
      labels: Type.Optional(Type.Boolean({ description: "Overlay interactive-element labels" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: {
          kind: "page.screenshot",
          tabId: params.tabId,
          ...(params.path ? { path: params.path } : {}),
          ...(params.fullPage ? { fullPage: params.fullPage } : {}),
          ...(params.labels ? { labels: params.labels } : {}),
        },
      });
    },
    renderCall: makeRenderCall("browser screenshot", (a) =>
      `[${shortId(a.tabId)}]${a.path ? ` → ${preview(a.path, 64)}` : ""}${a.fullPage ? " full" : ""}${a.labels ? " labels" : ""}`,
    ),
    // The image itself is rendered by the framework from the result's image
    // content blocks; this summary only adds the saved path / count, so the
    // screenshot rendering path stays intact.
    renderResult: makeRenderResult((view) => {
      const artifacts = (view.details.artifacts as Array<{ path: string }> | undefined) ?? [];
      if (artifacts[0]?.path) return `✓ ${clampBytes(stripTerminalControls(artifacts[0].path), 120)}`;
      const count = typeof view.details.imageCount === "number" ? view.details.imageCount : 0;
      return `✓ screenshot${count ? ` (${count} image)` : ""}${pageSuffix(view)}`;
    }),
  });

  // --- page: network --------------------------------------------------------

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    description:
      "Capture network responses of a managed tab: start capture, list requests (optional url substring filter), or stop. " +
      "Stopping does not erase the evidence: the retained entries stay queryable and the capture state (active/stopped/" +
      "interrupted/not-started) is reported, including after a worker interruption. A later explicit start replaces the " +
      "previous capture. Capture is bound to the tab.",
    promptSnippet: "Capture and inspect a tab's network requests",
    promptGuidelines: [
      "Use browser_network start before the action that triggers requests, then list with a url filter to inspect API calls of that tab.",
      "browser_network stop keeps the retained entries and reports the capture state and counts; if a request timed out or the worker was interrupted, the capture is marked interrupted (or not-started) instead of a silent empty list — list again to read what was retained, and only start a new capture when you mean to replace it.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      action: StringEnum(["start", "list", "stop"] as const),
      filter: Type.Optional(Type.String({ description: "URL substring filter for list" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: {
          kind: "page.network",
          tabId: params.tabId,
          action: params.action,
          ...(params.filter ? { filter: params.filter } : {}),
        },
      });
    },
    renderCall: makeRenderCall("browser network", (a) =>
      `[${shortId(a.tabId)}] ${a.action}${a.filter ? ` filter:${preview(a.filter, 40)}` : ""}`,
    ),
    renderResult: makeRenderResult((view) => {
      const action = typeof view.args.action === "string" ? view.args.action : "list";
      const meta = view.network;
      const entries = capturedEntryCount(view.value);
      const retained = meta?.retainedCount ?? entries;
      const status = meta?.status;
      const dropped = meta?.droppedCount ? ` · ${meta.droppedCount} dropped` : "";
      if (action === "start") {
        return `✓ capture ${status ?? "active"}${meta?.retainedCount !== undefined ? ` · ${meta.retainedCount} retained` : ""}${pageSuffix(view)}`;
      }
      if (action === "stop") {
        return `✓ capture ${status ?? "stopped"} · ${retained} retained${dropped}${pageSuffix(view)}`;
      }
      return `✓ ${retained} request(s)${status ? ` · ${status}` : ""}${dropped}${pageSuffix(view)}`;
    }),
  });

  // --- page: logs -----------------------------------------------------------

  pi.registerTool({
    name: "browser_logs",
    label: "Browser Logs",
    description:
      "Return buffered console/log output for a managed tab (most recent first-capped). Use it after an action to surface " +
      "hydration errors, failed requests, and runtime exceptions without attaching listeners.",
    promptSnippet: "Read a managed tab's buffered console logs",
    promptGuidelines: [
      "Use browser_logs after a navigate/click/submit to check for page errors; pass limit to bound how many lines you get back.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max log lines to return" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: { kind: "page.logs", tabId: params.tabId, ...(params.limit ? { limit: params.limit } : {}) },
      });
    },
    renderCall: makeRenderCall("browser logs", (a) => `[${shortId(a.tabId)}]${a.limit ? ` limit=${a.limit}` : ""}`),
    renderResult: makeRenderResult((view) => `✓ ${listCount(view, "logs")} log line(s)${pageSuffix(view)}`),
  });

  // --- page: execute (escape hatch) ----------------------------------------

  pi.registerTool({
    name: "browser_execute",
    label: "Browser Execute",
    description:
      "Escape hatch: run a Playwright snippet against a managed tab in the runtime's Node sandbox. Scope is fixed to the " +
      "requested tab (its `page`); there is no newPage/close/context escape. Each call is independent: you may keep plain " +
      "data or ids in variables you return, but page/locator/CDP handles cannot be reused across calls — re-acquire them " +
      "each time. Await every action to completion and leave no background timers running. keyboard/mouse/touchscreen input " +
      "is not supported right now. Errors and output are returned verbatim. Optional timeout in ms (runtime caps it at 120s).",
    promptSnippet: "Run a Playwright snippet against a managed tab (escape hatch)",
    promptGuidelines: [
      "Use browser_execute when the typed tools are insufficient (custom waits, iframes, multi-step flows); `page` is bound to the given tabId. Do not rely on page/locator/CDP objects surviving between calls (re-acquire them); await all actions and leave no background timers; keyboard/mouse/touchscreen input is unsupported for now. Never call browser.close()/context.close(); close tabs via browser_tabs.",
      "browser_execute conservatively invalidates the latest browser_snapshot (it may have changed the page): take a fresh snapshot before the next ref-based browser_click/browser_fill. Its returned value and the page logs it produced are reported in the tool result.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      code: Type.String({ description: "Playwright JS code, async/await supported" }),
      timeout: Type.Optional(Type.Integer({ minimum: 1000, description: "Timeout in ms (runtime caps at 120000)" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: { kind: "page.execute", tabId: params.tabId, code: params.code },
        timeoutMs: params.timeout,
      });
    },
    renderCall: makeRenderCall("browser execute", (a) => `[${shortId(a.tabId)}] ${preview(a.code, 72)}`),
    renderResult: makeRenderResult((view) => {
      const logs = listCount(view, "logs");
      const logSuffix = logs ? ` · ${logs} log line(s)` : "";
      if (view.value !== undefined) {
        return `✓ value: ${preview(view.value, 72)}${logSuffix}${pageSuffix(view)}`;
      }
      const firstLine = (view.text ?? "").split("\n").find((line) => line.trim());
      return firstLine
        ? `✓ ${preview(firstLine, 96)}${logSuffix}${pageSuffix(view)}`
        : `✓ done${logSuffix}${pageSuffix(view)}`;
    }),
  });

  // --- command: /browser-status (inspect only) ------------------------------

  pi.registerCommand("browser-status", {
    description: "Inspect the managed browser runtime: reachability, capabilities, and connected profiles",
    handler: async (_args, ctx) => {
      // Inspect only — never launch the runtime, never create a session/group/tab.
      const client = runtime.getClient();
      try {
        const caps = await runtime.probeCapabilities(client);
        if (!caps) {
          ctx.ui.notify(
            `browser runtime: not reachable at ${client.config.baseUrl} (start it with pi-browser-runtime or set PI_BROWSER_RUNTIME_PATH)`,
            "warning",
          );
          return;
        }
        const profiles = await client.listProfiles().catch(() => []);
        const connected = profiles.filter((p) => p.connected).length;
        const lines = [
          `browser runtime: reachable (${client.config.baseUrl})`,
          `protocol v${caps.protocolVersion} · managedGroups=${caps.managedGroups} explicitTabs=${caps.explicitTabs} isolatedExecution=${caps.isolatedExecution}`,
          `profiles: ${profiles.length} (${connected} connected)`,
        ];
        ctx.ui.notify(lines.join("\n"), connected > 0 ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(`browser-status unavailable: ${describeError(e)}`, "error");
      }
    },
  });

  // session.release only: frees this session's workers/CDP clients. Never
  // deletes groups/tabs or changes persistent ownership; never stops the runtime.
  // Page context is dropped too, so no title can outlive its session.
  pi.on("session_shutdown", async (_event, ctx) => {
    pageContext.clear();
    await runtime.releaseSession(ctx, `shutdown:${runtime.sessionId(ctx)}`).catch(() => {});
    runtime.reset();
  });
}
