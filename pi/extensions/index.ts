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
 * The headless-only `browser_save_as_pdf` tool is intentionally gone: it always
 * errored on headed extension sessions, so it is not registered.
 */

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  BrowserGroup,
  BrowserOperation,
  BrowserProfile,
  BrowserResultData,
  BrowserTab,
  BrowserTabCandidate,
} from "@tom-cat/pi-browser-runtime/browser-protocol";
import * as runtime from "./bootstrap.ts";
import { RuntimeRequestError } from "./runtime-client.ts";

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

const utf8 = new TextEncoder();
const byteLen = (s: string): number => utf8.encode(s).length;
// Slice a string down to at most `maxBytes` UTF-8 bytes on a code-point
// boundary. Binary-searches by UTF-16 code unit, then drops a trailing lone
// high surrogate so an astral char (emoji) is never split into a replacement
// character. The result is always valid UTF-8 and within budget.
function sliceToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLen(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // If we cut right after a high surrogate, its low half is on the far side of
  // the boundary — drop the orphan so we never emit U+FFFD.
  if (lo > 0) {
    const last = s.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo -= 1;
  }
  return s.slice(0, lo);
}

// --- rendering helpers -------------------------------------------------------

const preview = (v: unknown, limit = 96): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
};

function makeRenderCall(label: string, summarize: (args: Json) => string) {
  return (rawArgs: object, theme: Theme, context: { expanded: boolean }) => {
    const args = rawArgs as Json;
    const title = theme.fg("toolTitle", theme.bold(label));
    if (!context.expanded) {
      const s = summarize(args);
      return new Text(s ? `${title}\n${theme.fg("dim", s)}` : title, 0, 0);
    }
    return new Text(`${title}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`, 0, 0);
  };
}

function makeRenderResult(summarize: (details: Json) => string) {
  return (result: { details?: unknown; content?: ContentBlock[] }, options: { expanded: boolean }, theme: Theme, context?: RenderResultContext) => {
    const details = (result?.details ?? {}) as Json;
    // On error the framework marks the row; summarize the error text from
    // content instead of printing a misleading "✓".
    if (context?.isError) {
      const errText = (result.content ?? []).find((c): c is { type: "text"; text: string } => c.type === "text")?.text;
      return new Text(theme.fg("error", `✗ ${preview(errText ?? "failed", 160)}`), 0, 0);
    }
    if (!options.expanded) {
      return new Text(
        theme.fg("dim", `${summarize(details)}\n${keyHint("app.tools.expand", "to inspect output")}`),
        0,
        0,
      );
    }
    return new Text(theme.fg("toolOutput", JSON.stringify(details, null, 2)), 0, 0);
  };
}

/** Compact one-line description of a runtime error for the LLM. */
function describeError(e: unknown): string {
  if (e instanceof RuntimeRequestError) {
    const parts = [e.message];
    if (e.code) parts.push(`code=${e.code}`);
    if (e.outcome) parts.push(`outcome=${e.outcome}`);
    return parts.join(" · ");
  }
  return e instanceof Error ? e.message : String(e);
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

    return shapeResult(options.ctx, data);
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
  function shapeResult(ctx: ExtensionContext, data: BrowserResultData): { content: ContentBlock[]; details: Json } {
    const content: ContentBlock[] = [];
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
    const structured = buildStructuredText(data);
    if (structured) pushText(structured);

    // 2) Primary text (snapshot/navigate/etc.), truncated to its own cap first.
    const textTruncated = data.text != null && byteLen(data.text) > MAX_TEXT_BYTES;
    if (data.text) pushText(textTruncated ? `${sliceToBytes(data.text, MAX_TEXT_BYTES)}\n…[truncated]` : data.text);

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
    };
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
  function buildStructuredText(data: BrowserResultData): string {
    // Small ids that must always survive intact.
    const base: Json = {};
    if (data.snapshotId) base.snapshotId = data.snapshotId;
    if (data.group) base.group = compactGroup(data.group);
    if (data.tab) base.tab = compactTab(data.tab);

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

  const groupLine = (g: BrowserGroup): string => `${g.name} [${g.groupId}] profile=${g.profileId} ${g.state}`;
  const tabLine = (t: BrowserTab): string => `${t.title || "(untitled)"} [${t.tabId}] ${t.url} ${t.state}`;
  const profileLine = (p: BrowserProfile): string =>
    `${p.label} [${p.profileId}] ${p.browser} ${p.connected ? "connected" : "disconnected"}`;

  // Compact projections keep only the fields the LLM needs to act. Stable IDs
  // are kept intact; free-form display fields (name/url/title/label) are clamped
  // to MAX_FIELD_BYTES so a single resource with a huge title/url can never make
  // the structured block exceed its byte budget and force JSON slicing that
  // would drop the ids. Keeping an id != keeping an unbounded name.
  const clampField = (s: string | undefined): string => {
    if (s == null) return "";
    if (byteLen(s) <= MAX_FIELD_BYTES) return s;
    return `${sliceToBytes(s, MAX_FIELD_BYTES)}…`;
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
    renderResult: makeRenderResult((d) => {
      const profiles = (d.profiles as BrowserProfile[] | undefined) ?? [];
      if (profiles.length === 1) return `✓ ${profileLine(profiles[0])}`;
      return `✓ ${profiles.length} profile(s)`;
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
      `${a.action}${a.name ? ` "${a.name}"` : ""}${a.groupId ? ` [${a.groupId}]` : ""}${a.profileId ? ` profile=${a.profileId}` : ""}`,
    ),
    renderResult: makeRenderResult((d) => {
      if (d.group) return `✓ ${groupLine(d.group as BrowserGroup)}`;
      const groups = (d.groups as BrowserGroup[] | undefined) ?? [];
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
      "a page they are already looking at), attach (needs candidateId from discover — take control of that existing tab where " +
      "it is, without reloading, moving or regrouping it, and get back a normal tabId), activate (make a tab the active tab of " +
      "its window again after reading a link elsewhere), close, release (relinquish this session's control of a tab so a later " +
      "reconnect won't pull it back into this session). All actions take explicit ids; there is no implicit current tab.",
    promptSnippet: "List/create/attach/activate/close/release tabs, or discover the tabs already open",
    promptGuidelines: [
      "When the user says they are looking at a page and want you to continue there, call browser_tabs with action:\"discover\", pick the matching entry by title/URL/window, then action:\"attach\" with its candidateId — you get a normal tabId and keep working in that same tab (nothing is reloaded or moved).",
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
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const op = ((): BrowserOperation => {
        if (params.action === "discover") {
          return {
            kind: "tabs.discover",
            ...(params.profileId ? { profileId: params.profileId } : {}),
            ...(params.windowId !== undefined ? { windowId: params.windowId } : {}),
            ...(params.query ? { query: params.query } : {}),
            ...(params.includeManaged !== undefined ? { includeManaged: params.includeManaged } : {}),
          };
        }
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
      `${a.action}${a.groupId ? ` group=${a.groupId}` : ""}${a.tabId ? ` [${a.tabId}]` : ""}${a.candidateId ? ` ${a.candidateId}` : ""}${a.url ? ` ${preview(a.url, 64)}` : ""}`,
    ),
    renderResult: makeRenderResult((d) => {
      if (d.tab) return `✓ ${tabLine(d.tab as BrowserTab)}`;
      const tabs = (d.tabs as BrowserTab[] | undefined) ?? [];
      const candidates = (d.candidates as BrowserTabCandidate[] | undefined) ?? [];
      if (candidates.length > 0) {
        return `✓ ${candidates.length} open tab(s) discovered`;
      }
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
    renderCall: makeRenderCall("browser navigate", (a) => `[${a.tabId}] ${preview(a.url, 80)}`),
    renderResult: makeRenderResult((d) => `✓ ${preview((d.tab as BrowserTab | undefined)?.url ?? d.text ?? "ok", 96)}`),
  });

  // --- page: snapshot -------------------------------------------------------

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Read a managed tab as an accessibility tree with element refs (aria-ref=eN). Primary way to read page content and " +
      "get refs for browser_click/browser_fill. Optionally narrow with a CSS selector, a text search, or request the full tree.",
    promptSnippet: "Read a managed tab as an accessibility tree",
    promptGuidelines: [
      "Use browser_snapshot to read a tab's content and obtain aria-ref=eN refs; pass those refs (with the returned snapshotId) to browser_click/browser_fill. Refs are only valid against the snapshot that produced them.",
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      search: Type.Optional(Type.String({ description: "Only include nodes matching this text" })),
      selector: Type.Optional(Type.String({ description: "Scope the snapshot to a CSS selector" })),
      full: Type.Optional(Type.Boolean({ description: "Include the full tree (not just interactive nodes)" })),
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
      `[${a.tabId}]${a.selector ? ` selector=${a.selector}` : ""}${a.search ? ` search=${preview(a.search, 32)}` : ""}${a.full ? " full" : ""}`,
    ),
    renderResult: makeRenderResult((d) => {
      const lines = (d.text as string | undefined)?.split("\n").length ?? 0;
      return `✓ snapshot ${d.snapshotId ? `${d.snapshotId} · ` : ""}${lines} lines`;
    }),
  });

  // --- page: click ----------------------------------------------------------

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element in a managed tab. Pass either a snapshot ref (aria-ref=eN or @eN) together with the snapshotId it " +
      "came from, or a plain CSS/role selector. Selectors are matched strictly — an ambiguous selector is an error, not a guess.",
    promptSnippet: "Click an element by ref or CSS selector",
    promptGuidelines: [
      "Use browser_click with an aria-ref=eN from the latest browser_snapshot plus its snapshotId; if the page changed, re-snapshot first. A plain CSS selector must match exactly one element.",
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
    renderCall: makeRenderCall("browser click", (a) => `[${a.tabId}] ${a.selector}`),
    renderResult: makeRenderResult((d) => `✓ clicked${d.text ? ` · ${preview(d.text, 80)}` : ""}`),
  });

  // --- page: fill -----------------------------------------------------------

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description:
      "Set text into an input/textarea/contenteditable in a managed tab (clear-and-insert: existing content is replaced). " +
      "Target by snapshot ref (aria-ref=eN / @eN with its snapshotId) or a strict CSS selector.",
    promptSnippet: "Fill inputs and rich-text editors",
    promptGuidelines: [
      "Use browser_fill to replace an input's value; to append, read the current value with browser_evaluate, concatenate, then fill. Use an aria ref + snapshotId, or a strict CSS selector.",
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
    renderCall: makeRenderCall("browser fill", (a) => `[${a.tabId}] ${a.selector} ← "${preview(a.value, 40)}"`),
    renderResult: makeRenderResult((d) => `✓ filled${d.text ? ` · ${preview(d.text, 80)}` : ""}`),
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
    ],
    parameters: Type.Object({
      tabId: Type.String({ description: "Target managed tab" }),
      code: Type.String({ description: "JS code, async/await supported" }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return run({ ctx, toolCallId, signal, operation: { kind: "page.evaluate", tabId: params.tabId, code: params.code } });
    },
    renderCall: makeRenderCall("browser evaluate", (a) => `[${a.tabId}] ${preview(a.code, 80)}`),
    renderResult: makeRenderResult((d) => (d.value !== undefined ? `✓ → ${preview(d.value, 96)}` : `✓ ${preview(d.text ?? "ok", 96)}`)),
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
      `[${a.tabId}]${a.path ? ` → ${a.path}` : ""}${a.fullPage ? " full" : ""}${a.labels ? " labels" : ""}`,
    ),
    renderResult: makeRenderResult((d) => {
      const artifacts = (d.artifacts as Array<{ path: string }> | undefined) ?? [];
      if (artifacts[0]) return `✓ ${artifacts[0].path}`;
      return `✓ ${d.imageCount ?? 0} image(s)`;
    }),
  });

  // --- page: network --------------------------------------------------------

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    description:
      "Capture network responses of a managed tab: start capture, list requests (optional url substring filter), or stop " +
      "(which clears the capture). Capture is bound to the tab and cleaned up on stop.",
    promptSnippet: "Capture and inspect a tab's network requests",
    promptGuidelines: [
      "Use browser_network start before the action that triggers requests, then list with a url filter to inspect API calls of that tab.",
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
    renderCall: makeRenderCall("browser network", (a) => `[${a.tabId}] ${a.action}${a.filter ? ` filter:${a.filter}` : ""}`),
    renderResult: makeRenderResult((d) => {
      if (Array.isArray(d.value)) return `✓ ${(d.value as unknown[]).length} request(s)`;
      return `✓ ${preview(d.text ?? "ok", 64)}`;
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
    renderCall: makeRenderCall("browser logs", (a) => `[${a.tabId}]${a.limit ? ` limit=${a.limit}` : ""}`),
    renderResult: makeRenderResult((d) => `✓ ${((d.logs as string[] | undefined) ?? []).length} log line(s)`),
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
    renderCall: makeRenderCall("browser execute", (a) => `[${a.tabId}] ${preview(a.code, 80)}`),
    renderResult: makeRenderResult((d) => `✓ ${preview((d.text as string | undefined)?.split("\n")[0] ?? "ok", 96)}`),
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
  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.releaseSession(ctx, `shutdown:${runtime.sessionId(ctx)}`).catch(() => {});
    runtime.reset();
  });
}
