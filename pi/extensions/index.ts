/**
 * Pi Browser Use tools — managed runtime edition.
 *
 * These tools drive the user's real browser through the paired managed browser
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
 * The headless-only `browser_save_as_pdf` tool is intentionally gone: it always
 * errored on headed extension sessions, so it is not registered.
 */

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  BrowserArtifact,
  BrowserExtractImagesMode,
  BrowserFeatureFlags,
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
import { RuntimeRequestError, type BrowserRuntimeClient } from "./runtime-client.ts";
import {
  byteLen,
  clampBytes,
  pageLabel,
  preview,
  safeStringify,
  sanitizeValue,
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
type ExtractOperation = Extract<BrowserOperation, { kind: "page.extract" }>;
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

// --- dormant browser fleet ---------------------------------------------------
// Pi builds each request's loadout from `systemPromptOptions.selectedTools`, so
// dropping a tool there removes its schema, its snippet, and its guidelines from
// that request at once. The `browser` gateway stays resident; the browser_* fleet
// is hidden until the model calls the gateway in this Pi session — or forever
// when PI_BROWSER_TOOLS=always. Activation lives in memory keyed by sessionId
// (never a module-global boolean), so sessions cannot activate each other.
const GATEWAY_TOOL_NAME = "browser";
const FLEET_TOOL_PREFIX = "browser_";
const MAX_ACTIVATED_SESSIONS = 16;
const activatedSessions = new Set<string>();

/** PI_BROWSER_TOOLS=always keeps the whole fleet resident in every session. */
function browserToolsAlwaysOn(): boolean {
  return (process.env.PI_BROWSER_TOOLS ?? "").trim().toLowerCase() === "always";
}

/** Mark one session active; refresh recency and evict at the session bound. */
function activateSession(sessionId: string): void {
  activatedSessions.delete(sessionId);
  activatedSessions.add(sessionId);
  while (activatedSessions.size > MAX_ACTIVATED_SESSIONS) {
    const oldest = activatedSessions.values().next().value;
    if (oldest === undefined) break;
    activatedSessions.delete(oldest);
  }
}

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

/** Bounded copy of an optional `data.pageInfo` observation. */
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

/** Bounded copy of an optional `data.networkCapture` metadata object. */
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

/**
 * One-line extraction report for model-visible content: format, the page's own
 * metadata, the window that was asked for, and whether the text is a window of
 * the document. The exact figures also ride in the structured value block; this
 * line states "this is a window, not the whole extraction" in words instead of
 * leaving it to a JSON flag the model has to interpret.
 */
function extractSummaryLine({ data, operation }: { data: BrowserResultData; operation: ExtractOperation }): string {
  const value = isRecord(data.value) ? data.value : undefined;
  const metadata = value && isRecord(value.metadata) ? value.metadata : undefined;
  const readString = (source: Record<string, unknown> | undefined, key: string): string =>
    typeof source?.[key] === "string" ? source[key].trim() : "";
  const parts: string[] = [`format=${readString(value, "format") || operation.format}`];
  // The requested image mode explains what the text below contains: 'save'
  // rewrites saved image URLs to local artifact paths, 'urls' adds a manifest.
  if (operation.images && operation.images !== "none") parts.push(`images=${operation.images}`);
  const title = readString(value, "title");
  if (title) parts.push(`title="${preview(title, 120)}"`);
  const site = readString(metadata, "siteName");
  if (site) parts.push(`site=${preview(site, 80)}`);
  const author = readString(metadata, "author");
  if (author) parts.push(`author=${preview(author, 80)}`);
  const published = readString(metadata, "publishedTime");
  if (published) parts.push(`published=${preview(published, 64)}`);
  const totalBytes = value?.totalBytes;
  if (typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes >= 0) {
    parts.push(`${Math.floor(totalBytes)} bytes of extracted content`);
  }
  const window: string[] = [];
  if (operation.search) window.push(`search="${preview(operation.search, 60)}"`);
  if (operation.offset !== undefined) window.push(`offset=${operation.offset}`);
  if (operation.limit !== undefined) window.push(`limit=${operation.limit}`);
  if (window.length > 0) parts.push(`window ${window.join(" ")}`);
  const truncated = value?.truncated === true;
  parts.push(`truncated=${truncated}`);
  const hint = truncated
    ? " — a window of the extraction, not the whole document (narrow with search, page with offset/limit)"
    : "";
  return `extract: ${parts.join(" · ")}${hint}`;
}

// --- image assets (page.extract `images` / assets-manifest) ------------------
// The runtime answers image requests in `value` (the open JSON channel of the
// frozen protocol): `assets` is the manifest, `assetCount` its entry count,
// `assetsTruncated` the flag that the page has more images than the manifest
// carries, `assetsNotFetched` the images left over the per-request save limit
// and `failedAssets` the images it could not fetch and save. All of them are
// read defensively — a peer that returns none keeps the plain extraction shape.

const MAX_ASSET_ENTRIES_INLINE = 5; // manifest entries printed per line
const MAX_ASSET_SRC_COLS = 96; // visible columns per src
const MAX_ASSET_ALT_COLS = 64; // visible columns per alt text
const MAX_ASSET_REASON_COLS = 80; // visible columns per failure reason
const MAX_ARTIFACT_DESCRIPTORS = 10; // artifacts printed in model content

/**
 * One entry of the extract image manifest. The runtime reports the image's
 * intrinsic pixel size as `naturalWidth`/`naturalHeight` on both backends;
 * they are projected to `width`/`height` here because this type is the display
 * projection, while the untouched wire fields stay in the result `value`.
 */
type ImageAsset = {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
};

/** The asset channel of one extraction: manifest plus its counter fields. */
type ExtractAssets = {
  assets: ImageAsset[];
  /** Manifest size the runtime reported (`assetCount`), else the entries read. */
  count: number;
  /** `assetsTruncated`: the page has more images than the manifest carries. */
  truncated: boolean;
  /** `assetsNotFetched`: images over the save limit that were never attempted. */
  notFetched: number;
};

/** An image the runtime could not fetch/save, with the reason it reported. */
type FailedAsset = {
  src: string;
  reason?: string;
};

/** A non-negative integral quantity (a pixel size or an entry count), else undefined. */
function readCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * Read the asset channel of an extraction. Returns undefined when the response
 * carries none of it (a plain extraction), and skips manifest entries without a
 * usable src instead of printing empty rows. The counters are reported even
 * when the manifest itself is absent, which is the shape `images: "save"`
 * returns on Chrome: the saved bytes and the counts, but no listing.
 */
function readExtractAssets(value: unknown): ExtractAssets | undefined {
  if (!isRecord(value)) return undefined;
  const manifest = Array.isArray(value.assets) ? value.assets : undefined;
  const assets: ImageAsset[] = [];
  for (const entry of manifest ?? []) {
    if (!isRecord(entry)) continue;
    // srcset-only images have no src attribute; the rendered candidate is in currentSrc.
    const src = (typeof entry.src === "string" ? entry.src.trim() : "") ||
      (typeof entry.currentSrc === "string" ? entry.currentSrc.trim() : "");
    if (!src) continue;
    const alt = typeof entry.alt === "string" ? entry.alt.trim() : "";
    // Intrinsic size; 0 means the image reported no loaded dimensions.
    const width = readCount(entry.naturalWidth);
    const height = readCount(entry.naturalHeight);
    const sized = width !== undefined && height !== undefined && width > 0 && height > 0;
    assets.push({
      src: preview(src, MAX_ASSET_SRC_COLS),
      ...(alt ? { alt: preview(alt, MAX_ASSET_ALT_COLS) } : {}),
      ...(sized ? { width, height } : {}),
    });
  }
  const reported = readCount(value.assetCount);
  const truncated = value.assetsTruncated === true;
  const notFetched = readCount(value.assetsNotFetched) ?? 0;
  if (!manifest && reported === undefined && !truncated && notFetched === 0) return undefined;
  return { assets, count: reported ?? assets.length, truncated, notFetched };
}

/**
 * One-line manifest report: how many images the runtime's manifest carries,
 * whether it had to cut the listing short, how many images were left over the
 * save limit, then the first few entries with src/alt/pixel size, so the model
 * can decide which images are worth fetching without a second extraction. An
 * empty manifest is still reported — "0 image(s)" is a fact about the page, not
 * a missing answer.
 */
function assetManifestLine({
  assets,
  count,
  truncated,
  notFetched,
  max,
}: ExtractAssets & { max: number }): string {
  // The truncation and limit notices qualify the count, so they stay attached
  // to it instead of reading as another manifest entry.
  let head = `${count} image(s)`;
  if (truncated) head += ` (manifest truncated at ${count} — the page has more images than this listing)`;
  if (notFetched > 0) head += ` (${notFetched} image(s) not attempted — over the per-request save limit)`;
  const shown = assets.slice(0, max).map((asset) => {
    const entry = [asset.src];
    if (asset.alt) entry.push(`alt="${asset.alt}"`);
    if (asset.width !== undefined && asset.height !== undefined) entry.push(`${asset.width}x${asset.height}`);
    return entry.join(" ");
  });
  const hidden = assets.length - shown.length;
  const parts = [head, ...shown];
  if (hidden > 0) parts.push(`… ${hidden} more`);
  return `assets: ${parts.join(" · ")}`;
}

/**
 * Read `value.failedAssets`. Always returned as an array when the runtime
 * reported the field, so "saved nothing" is distinguishable from "no report".
 */
function readFailedAssets(value: unknown): FailedAsset[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.failedAssets)) return undefined;
  const failed: FailedAsset[] = [];
  for (const entry of value.failedAssets) {
    if (!isRecord(entry)) continue;
    const src = typeof entry.src === "string" ? entry.src.trim() : "";
    if (!src) continue;
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    failed.push({
      src: preview(src, MAX_ASSET_SRC_COLS),
      ...(reason ? { reason: preview(reason, MAX_ASSET_REASON_COLS) } : {}),
    });
  }
  return failed;
}

/**
 * One-line warning for images the runtime did not save. The saved ones have
 * their markdown URLs rewritten to local paths; these kept their remote URL,
 * which is exactly what the model has to know before quoting the text.
 */
function failedAssetsLine({ failed, max }: { failed: FailedAsset[]; max: number }): string {
  const shown = failed.slice(0, max).map((entry) => (entry.reason ? `${entry.src} (${entry.reason})` : entry.src));
  const hidden = failed.length - shown.length;
  const parts = [`${failed.length} image(s) not saved`, ...shown];
  if (hidden > 0) parts.push(`… ${hidden} more`);
  return `failed assets: ${parts.join(" · ")} — the text keeps their original remote URLs`;
}

// --- rendering helpers -------------------------------------------------------

const DISCOVER_DEFAULT_LIMIT = 20;
const MAX_DISCOVER_LIMIT = 200;
// Soft per-page byte budget for paginated discover candidates. Well below
// MAX_STRUCTURED_BYTES so the structured block never has to truncate the page
// again (which would make nextOffset lie about what was returned).
const DISCOVER_PAGE_BYTES = 16_000;
const MAX_SUMMARY_BYTES = 600;

/** One bounded, control-free line for folded rows. */
function sanitizeSummary(summary: string): string {
  return clampBytes(stripTerminalControls(summary).replace(/\s+/g, " ").trim(), MAX_SUMMARY_BYTES);
}

/** Pretty JSON of a sanitized copy, clamped to a byte budget. */
function boundedJson({ value, maxBytes }: { value: unknown; maxBytes: number }): string {
  let json: string;
  try {
    json = JSON.stringify(sanitizeValue(value), null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  return clampBytes(json, maxBytes);
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
    const body = context.expanded
      ? boundedJson({ value: args, maxBytes: MAX_RENDER_ARG_BYTES })
      : sanitizeSummary(summarize(args));
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
     * Optional pre-flight capability check, run before the operation is sent
     * with the same session/request identity. It may only read (list this
     * session's tabs, read profile capabilities) and throws to block an
     * operation the target profile cannot serve, with a model-facing reason.
     */
    precheck?: (options: {
      client: BrowserRuntimeClient;
      sessionId: string;
      requestId: string;
      signal: AbortSignal | undefined;
    }) => Promise<void>;
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
      // Capability precheck first: it runs on the same session identity and can
      // only read, so blocking here never leaves a page action half-started.
      if (options.precheck) {
        await options.precheck({ client, sessionId, requestId, signal: options.signal });
      }
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
    return shapeResult(options.ctx, data, sessionId, pageResult?.extraDetails, options.operation);
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
    operation?: BrowserOperation,
  ): { content: ContentBlock[]; details: Json } {
    const content: ContentBlock[] = [];
    // Optional runtime observations (frozen protocol fields) are copied with
    // bounded validation; they never replace or reshape `value`.
    const pageInfo = readPageInfo(data.pageInfo);
    const networkCapture = readNetworkCapture(data.networkCapture);
    // Remember every page fact the runtime already gave us so later rows can
    // show a title/domain without issuing any extra browser call. Keyed by the
    // Pi session; bounded per session.
    observePage({ sessionId, page: pageInfo });
    if (data.tab) observePage({ sessionId, page: { tabId: data.tab.tabId, url: data.tab.url, title: data.tab.title } });
    if (data.tabs) {
      for (const tab of data.tabs) {
        observePage({ sessionId, page: { tabId: tab.tabId, url: tab.url, title: tab.title } });
      }
    }
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
    const structured = buildStructuredText({ data, networkCapture, pageInfo });
    if (structured) pushText(structured);

    // 1b) Extraction report (page.extract): format, page metadata, requested
    // window, and whether the text that follows is a window of the document.
    if (operation?.kind === "page.extract") pushText(`\n${extractSummaryLine({ data, operation })}`);

    // 1c) Image manifest, its truncation/limit counters, and failed saves
    // (page.extract with `images`). The manifest is the zero-byte listing the
    // model decides from, so it stays model-visible even when the extraction
    // itself produced no text; a plain extraction (no asset channel in the
    // response) prints neither line.
    if (operation?.kind === "page.extract") {
      const assets = readExtractAssets(data.value);
      if (assets) pushText(`\n${assetManifestLine({ ...assets, max: MAX_ASSET_ENTRIES_INLINE })}`);
      const failed = readFailedAssets(data.value);
      if (failed && failed.length > 0) pushText(`\n${failedAssetsLine({ failed, max: MAX_ASSET_ENTRIES_INLINE })}`);
    }

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
      : operation?.kind === "page.network"
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

    // 4) Artifact descriptors (small): the durable copy on disk, with its real
    // written size when the runtime reported one. Paths come from the runtime,
    // so they are sanitized and byte-clamped like every other display field.
    // A `label` (the image alt text for saved assets) is appended when present;
    // the count is bounded, since saving images can produce many descriptors.
    if (data.artifacts && data.artifacts.length > 0) {
      const descriptors = data.artifacts.slice(0, MAX_ARTIFACT_DESCRIPTORS).map((artifact) => {
        const path = clampBytes(stripTerminalControls(artifact.path), MAX_FIELD_BYTES);
        const bytes = artifact.bytes;
        const size =
          typeof bytes === "number" && Number.isFinite(bytes) ? `, ${Math.max(0, Math.floor(bytes))} bytes` : "";
        const label = artifact.label ? ` "${preview(artifact.label, MAX_ASSET_ALT_COLS)}"` : "";
        return `${path} (${artifact.mimeType}${size})${label}`;
      });
      const hidden = data.artifacts.length - descriptors.length;
      if (hidden > 0) descriptors.push(`… ${hidden} more`);
      pushText(`\nartifacts: ${descriptors.join(", ")}`);
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
  function buildStructuredText({
    data,
    networkCapture,
    pageInfo,
  }: {
    data: BrowserResultData;
    networkCapture?: BrowserNetworkCaptureMetadata;
    pageInfo?: BrowserPageInfo;
  }): string {
    // Small facts that must always survive intact.
    const base: Json = {};
    if (data.snapshotId) base.snapshotId = data.snapshotId;
    if (data.group) base.group = compactGroup(data.group);
    if (data.tab) base.tab = compactTab(data.tab);
    if (networkCapture) base.networkCapture = compactNetworkCapture(networkCapture);
    // Observed page url/title are useful to the agent when no tab object was
    // returned; tabId stays exact, display fields are clamped.
    if (pageInfo) {
      base.pageInfo = {
        tabId: pageInfo.tabId,
        url: clampField(pageInfo.url),
        ...(pageInfo.title ? { title: clampField(pageInfo.title) } : {}),
      };
    }

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

  /**
   * Capability feature keys that change what the model can ask for. The feature
   * matrix is an open namespace by contract, so the client keeps every key it
   * receives (forward compatibility) — but only these are projected into
   * model-visible content: dumping arbitrary peer data there is noise, and a
   * key this build cannot act on is not something to plan around. `assets` is
   * here because browser_extract's `images` modes are gated on it per profile.
   */
  const MODEL_FEATURE_KEYS = ["extract", "assets"] as const;

  /**
   * Bounded projection of `capabilities.features` for model content. Returns
   * undefined when the peer advertises none of the relevant features, so a
   * plain Chrome profile keeps its compact shape and older profiles stay
   * unchanged.
   */
  const compactFeatures = (features: BrowserFeatureFlags | undefined): Json | undefined => {
    if (!features) return undefined;
    const out: Json = {};
    for (const key of MODEL_FEATURE_KEYS) {
      const values = features[key];
      if (!values || values.length === 0) continue;
      out[key] = values.map((value) => clampField(value));
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const compactProfile = (p: BrowserProfile): Json => {
    const caps = p.capabilities;
    const features = compactFeatures(caps.features);
    const limitations: string[] = [];
    let remainingBytes = 4_000;
    let limitationsTruncated = false;
    for (const limitation of caps.limitations ?? []) {
      if (remainingBytes < 4) {
        limitationsTruncated = true;
        break;
      }
      const clean = stripTerminalControls(limitation);
      const bounded = clampBytes(clean, Math.min(1_000, remainingBytes));
      if (bounded !== clean) limitationsTruncated = true;
      limitations.push(bounded);
      remainingBytes -= byteLen(bounded);
    }
    return {
      profileId: p.profileId,
      label: clampField(p.label),
      browser: p.browser,
      connected: p.connected,
      capabilities: {
        protocolVersion: caps.protocolVersion,
        managedGroups: caps.managedGroups,
        persistentOwnership: caps.persistentOwnership,
        explicitTabs: caps.explicitTabs,
        isolatedExecution: caps.isolatedExecution,
        ...(caps.existingTabControl !== undefined ? { existingTabControl: caps.existingTabControl } : {}),
        ...(caps.backend ? { backend: caps.backend } : {}),
        ...(caps.inputMode ? { inputMode: caps.inputMode } : {}),
        ...(caps.snapshotMode ? { snapshotMode: caps.snapshotMode } : {}),
        ...(caps.executeMode ? { executeMode: caps.executeMode } : {}),
        ...(caps.evaluateWorld ? { evaluateWorld: caps.evaluateWorld } : {}),
        ...(caps.supportedOperations ? { supportedOperations: caps.supportedOperations } : {}),
        ...(features ? { features } : {}),
        ...(caps.limitations ? { limitations } : {}),
        ...(limitationsTruncated ? { limitationsTruncated: true } : {}),
      },
    };
  };

  // --- human-facing result rows ---------------------------------------------
  // Folded: page/domain + action + counts, short-id fallback. Full ids stay in
  // model content and expanded detail; context comes only from runtime results.

  const pageContext = new PageContextStore();

  function observePage({
    sessionId,
    page,
  }: {
    sessionId: string | undefined;
    page: ObservedPage | undefined;
  }): void {
    if (page) pageContext.observe(sessionId, page);
  }

  function makeResultView({ args, details }: { args: Json; details: Json }): ResultView {
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

  function countList({ view, key }: { view: ResultView; key: string }): number {
    const value = view.details[key];
    return Array.isArray(value) ? value.length : 0;
  }

  /** Page suffix with a short-id fallback so a row keeps its tab identity. */
  function pageSuffix(view: ResultView): string {
    const label = pageLabel(view.page);
    if (label) return ` · ${label}`;
    const id = shortId(view.args.tabId);
    return id ? ` · ${id}` : "";
  }

  /** Captured entry count for either legacy value shape (array | entries). */
  function capturedEntryCount(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    if (isRecord(value) && Array.isArray(value.entries)) return value.entries.length;
    return 0;
  }

  const isTextBlock = (c: ContentBlock): c is { type: "text"; text: string } => c.type === "text";

  function renderErrorResult({
    result,
    options,
    theme,
  }: {
    result: { content?: ContentBlock[] };
    options: { expanded: boolean };
    theme: Theme;
  }) {
    const raw = (result.content ?? []).filter(isTextBlock).map((c) => c.text).join("\n");
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

  /** Bounded expanded detail: full ids first, display fields byte-capped. */
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
      if (Array.isArray(value) && value.length > 0) lines.push(...detailListLines({ key, items: value }));
    }
    if (typeof view.details.text === "string" && view.details.text) {
      lines.push("text:", clampBytes(stripTerminalControls(view.details.text), MAX_DETAIL_TEXT_BYTES));
    }
    if (view.value !== undefined) {
      // String leaves are sanitized before serialization, so a raw ESC in a
      // nested value cannot turn into visible `\u001b` JSON junk.
      const raw =
        typeof view.value === "string"
          ? stripTerminalControls(view.value)
          : safeStringify(sanitizeValue(view.value));
      lines.push("value:", clampBytes(raw, MAX_DETAIL_TEXT_BYTES));
    }
    if (Array.isArray(view.details.logs) && view.details.logs.length > 0) {
      const tail = view.details.logs.slice(-MAX_DETAIL_LOG_LINES).join("\n");
      lines.push("logs:", clampBytes(stripTerminalControls(tail), MAX_DETAIL_LOGS_BYTES));
    }
    if (Array.isArray(view.details.artifacts)) {
      for (const artifact of view.details.artifacts.slice(0, MAX_DETAIL_ITEMS)) {
        if (!isRecord(artifact) || typeof artifact.path !== "string") continue;
        const path = clampBytes(stripTerminalControls(artifact.path), MAX_FIELD_BYTES);
        const mime = typeof artifact.mimeType === "string" ? stripTerminalControls(artifact.mimeType) : "";
        const bytes = typeof artifact.bytes === "number" && Number.isFinite(artifact.bytes)
          ? Math.max(0, Math.floor(artifact.bytes))
          : undefined;
        const meta = [mime, bytes !== undefined ? `${bytes} bytes` : ""].filter(Boolean).join(", ");
        const label = typeof artifact.label === "string" && artifact.label
          ? ` "${preview(artifact.label, MAX_ASSET_ALT_COLS)}"`
          : "";
        lines.push(`artifact: ${path}${meta ? ` (${meta})` : ""}${label}`);
      }
    }
    const joined = lines.join("\n");
    if (byteLen(joined) <= MAX_DETAIL_BYTES) return joined;
    const marker = "\n…[detail truncated]";
    return `${sliceToBytes(joined, MAX_DETAIL_BYTES - byteLen(marker))}${marker}`;
  }

  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  /** One line per list entry with its FULL id, bounded by item count. */
  function detailListLines({ key, items }: { key: string; items: unknown[] }): string[] {
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
      if (context?.isError) return renderErrorResult({ result, options, theme });
      const rawDetails = isRecord(result?.details) ? result.details : {};
      const args = isRecord(context?.args) ? context.args : {};
      const view = makeResultView({ args, details: rawDetails });
      if (!options.expanded) {
        // Single sanitize choke point: every folded summary is bounded to one
        // control-free line, whatever raw values a tool interpolated.
        const line = sanitizeSummary(summarize(view)) || "done";
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
   * Page a full tabs.discover response locally (offset/limit never reach the
   * runtime). nextOffset counts the candidates actually returned, so a
   * byte-budget cut cannot skip an unseen entry.
   */
  function paginateDiscover({
    data,
    offset,
    limit,
  }: {
    data: BrowserResultData;
    offset: number | undefined;
    limit: number | undefined;
  }): { data: BrowserResultData; extraDetails: Json } {
    const total = data.candidates?.length ?? 0;
    const sorted = sortCandidates(data.candidates ?? []);
    const startOffset = Math.max(0, Math.floor(offset ?? 0));
    const pageSize = Math.min(Math.max(Math.floor(limit ?? DISCOVER_DEFAULT_LIMIT), 1), MAX_DISCOVER_LIMIT);
    const start = Math.min(startOffset, total);
    const requested = sorted.slice(start, start + pageSize);
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

  // --- tools ----------------------------------------------------------------
  // Resident text budget: each description carries only that tool's own
  // semantics (it ships with the schema on every request), promptGuidelines
  // carry cross-tool orchestration only, and longer-form detail lives in the
  // on-demand skill rather than here.

  // --- gateway (always resident) --------------------------------------------

  /**
   * Fleet names that exist in the registry but are missing from `active`, the
   * live loadout. getAllTools() is the registry, NOT the active set: it is read
   * only to learn the fleet's names, while getActiveTools() seeds the result, so
   * a tool the user switched off is never switched back on here.
   */
  function missingFleetToolNames(active: string[]): string[] {
    return (pi.getAllTools?.() ?? [])
      .map((tool) => tool.name)
      .filter((name) => name.startsWith(FLEET_TOOL_PREFIX) && !active.includes(name));
  }

  pi.registerTool({
    name: GATEWAY_TOOL_NAME,
    label: "Browser",
    description:
      "Activate this session's browser tools (browser_profiles, browser_groups, browser_tabs, browser_navigate, " +
      "browser_snapshot, browser_extract, browser_click, browser_fill, browser_evaluate, browser_screenshot, " +
      "browser_network, browser_logs, browser_execute). They stay dormant to keep the prompt small — call this first " +
      "whenever the task involves the user's browser tabs or pages: reading, driving, filling forms, or extracting " +
      "web content. Idempotent.",
    promptSnippet: "Activate the browser_* tools for this session",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (browserToolsAlwaysOn()) {
        return {
          content: [text("browser_* tools are already active (PI_BROWSER_TOOLS=always).")],
          details: { activated: true },
        };
      }
      const sessionId = runtime.sessionId(ctx);
      if (activatedSessions.has(sessionId)) {
        return { content: [text("browser_* tools are already active.")], details: { activated: false } };
      }
      // The loadout of the request that carried this call was filtered before the
      // call could land, so the live set is still missing the fleet: put it back
      // here and the next turn of this same run can already call browser_tabs.
      // Guarded because a harness without the loadout actions predates the
      // dormancy filter (there the fleet is resident and there is nothing to do).
      if (typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
        const active = pi.getActiveTools();
        const missing = missingFleetToolNames(active);
        if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
      }
      // Flagged only once the live loadout write has landed: a throw above leaves
      // the session un-flagged, so a retry can still finish the activation
      // instead of the filter hiding the fleet for the rest of the session.
      activateSession(sessionId);
      // Once per session, warm the shared runtime in the background so the first
      // real browser tool call does not pay the cold start. Fire-and-forget:
      // activation neither waits for it nor fails when the runtime is down — the
      // next tool call awaits the same shared launch anyway.
      void runtime.ensureRuntime().catch(() => {});
      return {
        content: [
          text(
            "browser_* tools are now active. Start with browser_profiles → browser_groups create → browser_tabs " +
              "create, or browser_tabs discover+attach to join a tab the user already has open.",
          ),
        ],
        details: { activated: true },
      };
    },
    renderCall: makeRenderCall("browser", () => ""),
    renderResult: makeRenderResult((view) =>
      view.details.activated === false ? "✓ browser tools already active" : "✓ browser tools activated",
    ),
  });

  // --- profiles -------------------------------------------------------------

  pi.registerTool({
    name: "browser_profiles",
    label: "Browser Profiles",
    description:
      "List the browser profiles (installed browser identities) known to the runtime, with connection state and " +
      "backend capabilities; a profileId from this list is required to create a group.",
    promptSnippet: "List available browser profiles",
    promptGuidelines: [
      "browser_profiles is the capability gate: a profile's capabilities decide what it serves — re-read rather than assume.",
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
        const backend = profile.capabilities.backend === "webextension" ? " · DOM input" : "";
        return `✓ ${profile.label} · ${profile.browser} · ${profile.connected ? "connected" : "disconnected"}${backend}`;
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
      "Manage this session's tab groups. Actions: list (this session), create (name + profileId), rename, close. Each " +
      "group binds to one fixed profile; same-name groups are allowed.",
    promptSnippet: "List/create/rename/close this session's tab groups",
    promptGuidelines: [
      "Ids are explicit: browser_groups create (name + profileId from browser_profiles) → browser_tabs create " +
      "(groupId + url) → page tools take the returned tabId; never guess a current tab or match by URL/title.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "rename", "close"] as const),
      profileId: Type.Optional(Type.String({ description: "create/list" })),
      name: Type.Optional(Type.String({ description: "create/rename" })),
      groupId: Type.Optional(Type.String({ description: "rename/close" })),
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
      "Work with tabs; no implicit current tab — every action takes explicit ids. list (this session's tabs, filter by " +
      "groupId or sourceTabId); create (groupId + url); discover (real tabs already open in connected profiles: " +
      "total/returned/nextOffset/truncated; page on with offset=nextOffset); attach (take over a candidateId in " +
      "place — no reload, no move, scroll/form kept); activate; close; release (give up control; a reconnect won't pull " +
      "the tab back).",
    promptSnippet: "List/create/attach/activate/close/release tabs, or discover the tabs already open",
    promptGuidelines: [
      "User points at an open page: browser_tabs discover, then attach that candidateId in place (no " +
      "reload/move/regroup); a link that opened a tab: browser_tabs list sourceTabId=<the clicked tab>, then " +
      "browser_tabs activate.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "discover", "attach", "activate", "create", "close", "release"] as const),
      // The tool description above already maps every action to its fields, so a
      // field only carries a description when that mapping does not state it —
      // this schema is resident text the moment the fleet is active.
      groupId: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      tabId: Type.Optional(Type.String({ description: "close/release/activate" })),
      sourceTabId: Type.Optional(Type.String()),
      candidateId: Type.Optional(Type.String()),
      profileId: Type.Optional(Type.String({ description: "discover" })),
      windowId: Type.Optional(Type.Integer({ description: "discover" })),
      query: Type.Optional(Type.String({ description: "discover: title/URL text" })),
      includeManaged: Type.Optional(Type.Boolean({ description: "discover: false hides managed tabs" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "discover: use nextOffset" })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_DISCOVER_LIMIT, description: "discover: default 20" }),
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
          refine: (data) => paginateDiscover({ data, offset: params.offset, limit: params.limit }),
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
      "Move a tab (by tabId). goto navigates and returns the final URL after redirects; back follows the tab's real " +
      "browser history, never a re-navigation of the old URL. If a link opened a new tab, use browser_tabs activate.",
    promptSnippet: "Navigate a managed tab, or go back in its history",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      url: Type.Optional(Type.String({ description: "goto: URL" })),
      action: Type.Optional(
        StringEnum(["goto", "back"] as const, { description: "goto (default) or back" }),
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
      "Read a managed tab as a readable accessibility tree with element refs (aria-ref=eN). Default is the readable " +
      "tree, not interactive-only, so it can be large — narrow with search or a strict CSS selector matching one " +
      "element, or interactiveOnly for just the actionable controls. Output is bounded; full asks for the whole tree.",
    promptSnippet: "Read a managed tab as an accessibility tree",
    promptGuidelines: [
      "browser_snapshot owns the refs: browser_click/browser_fill need an aria-ref=eN plus the snapshotId it came " +
      "from; any browser_evaluate/browser_execute invalidates the snapshot (even read-only), so re-snapshot before " +
      "the next ref action.",
      "Work observe → act → observe: browser_navigate/browser_snapshot to load and read, one acting tool, then a " +
      "fresh snapshot or evaluate to verify — pages change, so never chain blindly or re-click a dead control.",
      "Skip browser_snapshot when browser_click/browser_fill have a nameable target (visible text, role, or label): " +
      "call the acting tool directly with a strict selector; use snapshot→ref when the page is unknown, you must read " +
      "content, or a strict selector errors, then snapshot to find the right target.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      search: Type.Optional(Type.String({ description: "node text filter" })),
      selector: Type.Optional(Type.String({ description: "CSS scope" })),
      full: Type.Optional(Type.Boolean({ description: "whole tree" })),
      interactiveOnly: Type.Optional(Type.Boolean({ description: "only actionable controls" })),
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
          ...(params.interactiveOnly ? { interactiveOnly: params.interactiveOnly } : {}),
        },
      });
    },
    renderCall: makeRenderCall("browser snapshot", (a) =>
      `[${shortId(a.tabId)}]${a.selector ? ` selector=${preview(a.selector, 40)}` : ""}${a.search ? ` search=${preview(a.search, 32)}` : ""}${a.full ? " full" : ""}${a.interactiveOnly ? " interactive-only" : ""}`,
    ),
    renderResult: makeRenderResult((view) => {
      const lines = view.text ? view.text.split("\n").length : 0;
      const refs = isRecord(view.value) && Array.isArray(view.value.refs) ? view.value.refs.length : 0;
      const snapshot = view.details.snapshotId ? ` · ${shortId(view.details.snapshotId)}` : "";
      return `✓ snapshot ${lines} lines${refs ? ` · ${refs} refs` : ""}${snapshot}${pageSuffix(view)}`;
    }),
  });

  // --- page: extract --------------------------------------------------------

  /**
   * Pre-flight capability gate for page.extract. The runtime reports which page
   * operations each profile advertises; when the target tab's profile lists
   * them and page.extract is missing, fail here with a model-facing reason
   * instead of sending an operation that browser build cannot serve. A profile
   * that advertises no list at all is NOT blocked — absence is not a claim of
   * "unsupported", it only means the peer predates the list — and an unknown
   * tabId is left to the extract request so the runtime reports the real
   * resource error instead of this gate inventing one.
   *
   * `images` is gated one level deeper, on `capabilities.features.assets`: a
   * webextension (Firefox) build downloads the bytes itself, so it must say
   * which modes it can serve. A missing mode is refused here rather than
   * surfacing as an unsupported-capability after a partial download. Chrome is
   * served by the runtime, which synthesizes its feature set, and a profile
   * with no capabilities at all predates this negotiation — both are left to
   * the runtime, matching the layering used for supportedOperations.
   *
   * Both probes are reads: tabs.list is answered from the runtime's own session
   * inventory and profiles.list is connection metadata, so refusing here starts
   * nothing and changes nothing.
   */
  async function assertExtractSupported({
    client,
    sessionId,
    requestId,
    signal,
    tabId,
    images,
  }: {
    client: BrowserRuntimeClient;
    sessionId: string;
    requestId: string;
    signal: AbortSignal | undefined;
    tabId: string;
    images: BrowserExtractImagesMode | undefined;
  }): Promise<void> {
    const listed = await client.request({
      requestId: `${requestId}:extract-gate`,
      sessionId,
      operation: { kind: "tabs.list" },
      ...(signal ? { signal } : {}),
    });
    const tab = listed.tabs?.find((entry) => entry.tabId === tabId);
    if (!tab) return;
    const profiles = await client.listProfiles(signal);
    const profile = profiles.find((entry) => entry.profileId === tab.profileId);
    const label = profile ? `${profile.label} (${profile.browser}, ${profile.profileId})` : tab.profileId;
    const supported = profile?.capabilities.supportedOperations;
    if (supported && !supported.includes("page.extract")) {
      throw new Error(
        `browser_extract is not supported by this tab's browser profile: ${label} does not advertise page.extract. ` +
          "Check browser_profiles for each connected profile's capabilities, or read the page with browser_snapshot/browser_evaluate.",
      );
    }
    if (!images || images === "none") return;
    const capabilities = profile?.capabilities;
    if (!capabilities) return;
    if (capabilities.backend !== "webextension") return;
    const modes = capabilities.features?.assets;
    if (modes?.includes(images)) return;
    const advertised = modes && modes.length > 0 ? modes.join(", ") : "none";
    throw new Error(
      `browser_extract images="${images}" is unsupported by this tab's browser profile: ${label} does not advertise the asset mode "${images}" ` +
        `(advertised asset modes: ${advertised}). Update that browser's extension, or extract with images="none"/"urls" on this profile.`,
    );
  }

  pi.registerTool({
    name: "browser_extract",
    label: "Browser Extract",
    description:
      "Extract a managed tab's content: markdown (default), text, html, or an assets-manifest of its images. Returns no " +
      "refs and never touches the page, so the snapshot stays valid. Bounded: truncated/totalBytes reported; " +
      "search/offset/limit window the lines. A path confines the full export to the runtime's artifacts directory. " +
      "images: none/urls/save — remote URLs, manifest, or download (markdown URLs rewritten). Needs a " +
      "page.extract-capable profile (see browser_profiles).",
    promptSnippet: "Extract a managed tab's content as markdown/text/html or an image manifest",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      format: Type.Optional(
        StringEnum(["markdown", "text", "html", "assets-manifest"] as const, {
          description: "Extraction format (default: markdown)",
        }),
      ),
      images: Type.Optional(
        StringEnum(["none", "urls", "save"] as const, {
          description: "none (default)|urls|save; urls=manifest, save=download",
        }),
      ),
      search: Type.Optional(Type.String({ description: "line text filter" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "lines to skip" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "max lines" })),
      path: Type.Optional(
        Type.String({ description: "artifacts-dir export path" }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({
        ctx,
        toolCallId,
        signal,
        operation: {
          kind: "page.extract",
          tabId: params.tabId,
          format: params.format ?? "markdown",
          ...(params.images && params.images !== "none" ? { images: params.images } : {}),
          ...(params.search ? { search: params.search } : {}),
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.path ? { path: params.path } : {}),
        },
        precheck: ({ client, sessionId, requestId, signal: gateSignal }) =>
          assertExtractSupported({
            client,
            sessionId,
            requestId,
            signal: gateSignal,
            tabId: params.tabId,
            images: params.images,
          }),
      });
    },
    renderCall: makeRenderCall("browser extract", (a) =>
      `[${shortId(a.tabId)}] ${str(a.format) || "markdown"}${a.images && a.images !== "none" ? ` images=${a.images}` : ""}${a.search ? ` search=${preview(a.search, 32)}` : ""}${a.offset !== undefined ? ` offset=${a.offset}` : ""}${a.limit !== undefined ? ` limit=${a.limit}` : ""}${a.path ? ` → ${preview(a.path, 64)}` : ""}`,
    ),
    // The row reports what the model got: format and size, a first-line
    // preview, the page's own metadata, whether it is a window, the image
    // manifest or the images that failed, and the artifact the runtime wrote.
    renderResult: makeRenderResult((view) => {
      const value = isRecord(view.value) ? view.value : undefined;
      const metadata = value && isRecord(value.metadata) ? value.metadata : undefined;
      const format = (typeof value?.format === "string" && value.format) || str(view.args.format) || "markdown";
      const assets = readExtractAssets(view.value);
      const failed = readFailedAssets(view.value) ?? [];
      const lines = view.text ? view.text.split("\n").length : 0;
      const firstLine = (view.text ?? "").split("\n").find((line) => line.trim());
      // The manifest IS the payload of `format: "assets-manifest"`, so the row
      // shows the listing itself instead of an empty line count.
      const manifestIsPayload = format === "assets-manifest" && assets !== undefined;
      const body =
        manifestIsPayload && assets
          ? preview(assetManifestLine({ ...assets, max: MAX_ASSET_ENTRIES_INLINE }), 120)
          : `${lines} line(s)`;
      const title = typeof value?.title === "string" && value.title ? `"${preview(value.title, 56)}"` : "";
      const site = typeof metadata?.siteName === "string" && metadata.siteName
        ? `site=${preview(metadata.siteName, 40)}`
        : "";
      const totalBytes = typeof value?.totalBytes === "number" ? `${value.totalBytes} bytes` : "";
      const truncated = value?.truncated === true ? "truncated" : "";
      const artifacts = (view.details.artifacts as BrowserArtifact[] | undefined) ?? [];
      const saved = artifacts[0];
      const artifactLine = saved
        ? `${clampBytes(stripTerminalControls(saved.path), 96)}${typeof saved.bytes === "number" ? ` (${saved.bytes} bytes)` : ""}`
        : "";
      const head = [
        `${format} · ${body}`,
        firstLine ? preview(firstLine, 80) : "",
        title,
        site,
        totalBytes,
        truncated,
        !manifestIsPayload && assets ? `${assets.count} image(s)` : "",
        artifacts.length > 1 ? `${artifacts.length} artifacts` : "",
        failed.length > 0 ? `${failed.length} failed` : "",
        artifactLine,
      ];
      return `✓ ${head.filter(Boolean).join(" · ")}${pageSuffix(view)}`;
    }),
  });

  // --- page: click ----------------------------------------------------------

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element in a managed tab. Pass either a snapshot ref (aria-ref=eN or @eN) with the snapshotId it came " +
      "from, or a plain Playwright selector — CSS, text=, or role= — which needs no snapshot. Selectors match " +
      "strictly — zero or multiple matches is an error, never a guess.",
    promptSnippet: "Click an element by ref or CSS selector",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      selector: Type.String(),
      snapshotId: Type.Optional(Type.String({ description: "for aria refs" })),
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
      "Set text into an input/textarea/contenteditable; existing content is replaced. Target by " +
      "snapshot ref (aria-ref=eN / @eN with its snapshotId) or a plain Playwright selector — CSS, text=, or role= — " +
      "matching one element with no snapshot. To append, read the value with browser_evaluate, concatenate and fill that.",
    promptSnippet: "Fill inputs and rich-text editors",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      selector: Type.String(),
      value: Type.String({ description: "replaces content" }),
      snapshotId: Type.Optional(Type.String({ description: "for aria refs" })),
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
      "Run JS in a tab's page (document/window, async/await) for reads a snapshot cannot express. End with " +
      "`return <value>`: a bare expression returns undefined. Firefox stays in an isolated world (153+, optional " +
      "permission); for Node/Playwright use browser_execute.",
    promptSnippet: "Run JavaScript in a managed tab's page",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      code: Type.String(),
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
  // The inline image depends on the model being able to see images; a text-only
  // model still gets the text summary, so the description states that premise.

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Screenshot a managed tab. The image returns inline (when the model can see images) and is saved when a path is " +
      "given; fullPage captures the whole scrollable page, labels overlays interactive-element labels. Use it for visual " +
      "questions only — browser_snapshot is cheaper for text.",
    promptSnippet: "Screenshot a managed tab",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      path: Type.Optional(Type.String({ description: "absolute path" })),
      fullPage: Type.Optional(Type.Boolean()),
      labels: Type.Optional(Type.Boolean()),
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
      "Capture a managed tab's network responses: start before the triggering action, list (optional url substring " +
      "filter), or stop. Stopping does not clear the evidence: retained entries stay queryable, and the state " +
      "(active/stopped/interrupted/not-started) is reported truthfully. Bound to one tab; start replaces the " +
      "previous capture.",
    promptSnippet: "Capture and inspect a tab's network requests",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      action: StringEnum(["start", "list", "stop"] as const),
      filter: Type.Optional(Type.String()),
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
      const status = meta?.status;
      const dropped = meta?.droppedCount ? ` · ${meta.droppedCount} dropped` : "";
      if (action === "start") {
        return `✓ capture ${status ?? "active"}${meta ? ` · ${meta.retainedCount} retained` : ""}${pageSuffix(view)}`;
      }
      if (action === "stop") {
        return `✓ capture ${status ?? "stopped"} · ${meta?.retainedCount ?? entries} retained${dropped}${pageSuffix(view)}`;
      }
      // A filtered list returns matching entries, while retainedCount is the
      // whole capture: label both so matches are not mistaken for the total.
      const retainedTotal = meta?.retainedCount;
      const totalSuffix =
        retainedTotal !== undefined && retainedTotal !== entries ? ` of ${retainedTotal} retained` : "";
      return `✓ ${entries} request(s)${totalSuffix}${status ? ` · ${status}` : ""}${dropped}${pageSuffix(view)}`;
    }),
  });

  // --- page: logs -----------------------------------------------------------

  pi.registerTool({
    name: "browser_logs",
    label: "Browser Logs",
    description:
      "Return a managed tab's buffered console/log output, most recent last. Use after an action to catch hydration errors, " +
      "failed requests, and runtime exceptions; no listeners needed.",
    promptSnippet: "Read a managed tab's buffered console logs",
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "max lines" })),
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
    renderResult: makeRenderResult((view) => `✓ ${countList({ view, key: "logs" })} log line(s)${pageSuffix(view)}`),
  });

  // --- page: execute (escape hatch) ----------------------------------------

  pi.registerTool({
    name: "browser_execute",
    label: "Browser Execute",
    description:
      "Escape hatch: run Playwright code in the runtime's Node sandbox when typed tools fall short. Scope is the target " +
      "tab's `page`; no newPage/close/context. Handles cannot cross calls; re-acquire each time. Await every action, no " +
      "background timers. Chrome exposes no native keyboard/mouse; Firefox supports only a DOM-compatible subset. " +
      "Errors return verbatim.",
    promptSnippet: "Run a Playwright snippet against a managed tab (escape hatch)",
    promptGuidelines: [
      "A cancelled/timed-out call reports outcome=not-started or outcome=unknown; unknown may have partially " +
      "happened — re-observe with browser_snapshot, never replay the action.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Managed tab" }),
      code: Type.String(),
      timeout: Type.Optional(Type.Integer({ minimum: 1000, description: "ms (runtime caps 120000)" })),
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
      const logs = countList({ view, key: "logs" });
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

  // --- dormancy filter ------------------------------------------------------
  // Pure filtering: no resources are created and nothing is sent anywhere. A
  // session that has called the gateway (or PI_BROWSER_TOOLS=always) is left
  // untouched so its prompt stays byte-identical across requests.
  pi.on("before_agent_start", async (event, ctx) => {
    if (browserToolsAlwaysOn()) return;
    // A harness with no started session has no usable gateway either (the
    // gateway throws there), so filtering would hide the fleet with no way back:
    // leave such a loadout alone and keep the tools resident.
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    if (activatedSessions.has(sessionId)) return;
    // `selectedTools` is optional in older pi type definitions and always
    // present from 0.87 on: treat a missing list as "nothing to filter" (an
    // older harness has no loadout to rewrite) instead of emptying it.
    const selectedTools = event.systemPromptOptions.selectedTools;
    if (!selectedTools?.some((name) => name.startsWith(FLEET_TOOL_PREFIX))) return;
    event.systemPromptOptions.selectedTools = selectedTools.filter((name) => !name.startsWith(FLEET_TOOL_PREFIX));
  });

  // session.release only: frees this session's workers/CDP clients. Never
  // deletes groups/tabs or changes persistent ownership; never stops the runtime.
  // Only THIS session's page context is dropped — other sessions keep theirs.
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = runtime.sessionId(ctx);
    activatedSessions.delete(sessionId);
    pageContext.clear(sessionId);
    await runtime.releaseSession(ctx, `shutdown:${sessionId}`).catch(() => {});
    runtime.reset();
  });
}
