/**
 * Deterministic batch fill for `browser_fill_form`: one call fills a whole form
 * with no model in the loop. Validate the batch, resolve EVERY strict selector
 * before the first keystroke, then fill one field per runtime call.
 *
 * Resolution reuses `page.extract` with a strict `selector` scope. That op
 * resolves the selector through the same single-match path `page.fill` uses
 * (Playwright's strict locator on the CDP backend, `strictElement` on the DOM
 * backend) and therefore accepts exactly the engines the fill accepts (CSS and
 * `text=`/`role=`/`internal:label=` on CDP, CSS and `role=` on the DOM backend).
 * It is a read: it never mutates the page and never replaces or invalidates the
 * tab's latest snapshot. A rejected batch therefore changes nothing at all,
 * while a snapshot-scoped probe would re-walk the whole DOM/accessibility tree
 * per field and invalidate refs the caller may still hold.
 *
 * Snapshot refs (`aria-ref=eN`, `@eN`) are rejected up front: every fill
 * invalidates the latest snapshot, so a ref would be dead for every field after
 * the first, and plain selectors have no such problem.
 */

import type { BrowserOperation, BrowserResultData } from "@tom-cat/pi-browser-runtime/browser-protocol";
import * as runtime from "./bootstrap.ts";
import { RuntimeRequestError, type BrowserRuntimeClient } from "./runtime-client.ts";
import { clampBytes, preview, stripTerminalControls } from "./ui-format.ts";

/** Schema bound: the batch is sequential, so an unbounded list outlives any deadline. */
export const MAX_FILL_FORM_FIELDS = 30;

/**
 * Wall-clock ceiling for the resolve pass (internal, NOT part of the tool
 * schema): 30 strict probes against a fully broken batch would otherwise stack
 * up ~150s of selector timeouts before the first fill is even tried.
 */
const DEFAULT_RESOLVE_BUDGET_MS = 30_000;

/** `30_000` -> `30s`, `600` -> `0.6s`: the budget as the model reads it. */
function formatResolveBudget(budgetMs: number): string {
  const seconds = budgetMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))}s`;
}

// Model-facing content stays bounded by construction: at most MAX_FILL_FORM_FIELDS
// entries of a clamped selector + clamped error. `details` keeps the untruncated
// text for the UI.
const MAX_CONTENT_SELECTOR_BYTES = 200;
const MAX_CONTENT_ERROR_BYTES = 300;

type Json = Record<string, unknown>;

export type FillFormField = { selector: string; value: string };

/** `not-attempted` is a real outcome: the batch stopped before reaching that field. */
export type FillFormFieldStatus = "filled" | "failed" | "not-attempted";

export type FillFormFieldOutcome = {
  /** Exactly the selector the caller passed. */
  selector: string;
  status: FillFormFieldStatus;
  /** Runtime failure as `message · code=… · outcome=…`, when the field failed. */
  error?: string;
};

/**
 * `filled`   — every field was filled.
 * `partial`  — some fields were filled; the batch stopped at the first failed fill.
 * `failed`   — nothing was filled and the first fill already failed.
 * `rejected` — nothing was filled and no fill was attempted (validation or resolution).
 */
export type FillFormStatus = "filled" | "partial" | "failed" | "rejected";

export type FillFormContentBlock = { type: "text"; text: string };

export type FillFormValidation = { ok: true } | { ok: false; problem: string };

/**
 * Mirror of the executor's ref detection (`aria-ref=…`, `@…`, trimmed): a ref is
 * only valid while the snapshot it came from is current.
 */
function isSnapshotRef(selector: string): boolean {
  const normalized = selector.trim();
  return normalized.startsWith("aria-ref=") || normalized.startsWith("@");
}

/** Refuse the batch before any runtime call: refs, empty selectors, size. */
export function validateFillFormFields({ fields }: { fields: FillFormField[] }): FillFormValidation {
  if (fields.length === 0) {
    return { ok: false, problem: "fields must contain at least one {selector, value} entry" };
  }
  if (fields.length > MAX_FILL_FORM_FIELDS) {
    return {
      ok: false,
      problem: `fields is limited to ${MAX_FILL_FORM_FIELDS} entries per call; split the form across several browser_fill_form calls`,
    };
  }
  const refs: string[] = [];
  const empty: number[] = [];
  for (const [index, field] of fields.entries()) {
    const selector = field.selector.trim();
    if (!selector) {
      empty.push(index + 1);
      continue;
    }
    if (isSnapshotRef(selector)) refs.push(preview(selector, 40));
  }
  if (refs.length > 0) {
    return {
      ok: false,
      problem:
        `snapshot refs are not supported (${refs.join(", ")}): every fill invalidates the latest snapshot, so a ref would be dead for every field after the first. ` +
        "Pass a strict plain selector (CSS, text=, role=, internal:label=) per field, or use browser_fill for a single ref.",
    };
  }
  if (empty.length > 0) {
    return { ok: false, problem: `field(s) ${empty.join(", ")} have an empty selector` };
  }
  return { ok: true };
}

/**
 * One runtime call of the batch, holding the same discipline as the single-op
 * choke point in index.ts: a timed-out op is cancelled with a SEPARATE request
 * (page actions are never replayed) and a runtime-unreachable failure drops the
 * cached process state so a later call re-probes instead of failing forever.
 * Every op derives its own requestId — the relay dedups by sessionId+requestId
 * (and rejects a reused id with a different payload), so ids must stay unique.
 */
async function callOperation({
  client,
  sessionId,
  cwd,
  signal,
  requestId,
  operation,
}: {
  client: BrowserRuntimeClient;
  sessionId: string;
  cwd: string | undefined;
  signal: AbortSignal | undefined;
  requestId: string;
  operation: BrowserOperation;
}): Promise<BrowserResultData> {
  try {
    return await client.request({
      requestId,
      sessionId,
      operation,
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof RuntimeRequestError && e.category === "timeout") {
      await client.cancel({ sessionId, requestId: `${requestId}:cancel`, targetRequestId: requestId });
    }
    if (e instanceof RuntimeRequestError && e.category === "runtime-unreachable") {
      runtime.reset();
    }
    throw e;
  }
}

/**
 * One control-free line for a failed op: the runtime's message (clamped, so the
 * code/outcome markers always survive) plus `code=`/`outcome=`. Non-runtime
 * errors pass their own message through unclamped; the model-facing copy is
 * bounded again when the report is built.
 */
function describeFailure(e: unknown): string {
  if (!(e instanceof RuntimeRequestError)) {
    return stripTerminalControls(e instanceof Error ? e.message : String(e));
  }
  const markers = [e.code ? `code=${e.code}` : "", e.outcome ? `outcome=${e.outcome}` : ""].filter(Boolean).join(" · ");
  const budget = MAX_CONTENT_ERROR_BYTES - (markers ? markers.length + 3 : 0);
  const message = clampBytes(stripTerminalControls(e.message), Math.max(0, budget));
  return markers ? `${message} · ${markers}` : message;
}

/**
 * True when the failure is not a fact about the selector: a transport/protocol
 * failure (unreachable, unauthorized, timeout, bad request, HTTP) means the
 * whole batch cannot run, while an `operation` failure is the runtime's answer
 * about this one field.
 */
function isTransportFailure(e: unknown): boolean {
  return e instanceof RuntimeRequestError && e.category !== "operation";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The model-facing report: a one-line status, the per-field JSON, and — when a
 * fill ended with outcome=unknown — the fact that it may have partially applied.
 * `details` carries the same shape for the UI with untruncated selectors/errors.
 */
function buildReport({
  tabId,
  status,
  fields,
  issue,
  partiallyApplied,
  pageInfo,
}: {
  tabId: string;
  status: FillFormStatus;
  fields: FillFormFieldOutcome[];
  /** Why nothing was filled; set for `rejected` only. */
  issue?: string;
  /** A fill ended with outcome=unknown, so it may have partially applied. */
  partiallyApplied?: boolean;
  pageInfo?: Json;
}): { content: FillFormContentBlock[]; details: Json } {
  const filled = fields.filter((field) => field.status === "filled").length;
  const failed = fields.filter((field) => field.status === "failed").length;
  const notAttempted = fields.filter((field) => field.status === "not-attempted").length;
  const firstFailed = fields.find((field) => field.status === "failed");
  const failedPosition = firstFailed ? fields.indexOf(firstFailed) + 1 : 0;

  const summary = ((): string => {
    if (status === "filled") return `Filled all ${filled} field(s) of the form.`;
    if (status === "rejected") return `Nothing was filled: ${issue ?? "no field could be resolved"}.`;
    const position = firstFailed ? ` at field ${failedPosition} ("${preview(firstFailed.selector, 60)}")` : "";
    const detail = firstFailed?.error ? `: ${firstFailed.error}` : "";
    const rest = notAttempted > 0 ? `; the ${notAttempted} field(s) after it were not attempted` : "";
    return `Filled ${filled} of ${fields.length} field(s); stopped${position}${detail}${rest}.`;
  })();

  const report: Json = {
    tabId,
    status,
    filled,
    failed,
    notAttempted,
    ...(issue ? { issue } : {}),
    fields: fields.map((field) => {
      return {
        selector: clampBytes(stripTerminalControls(field.selector), MAX_CONTENT_SELECTOR_BYTES),
        status: field.status,
        ...(field.error ? { error: clampBytes(stripTerminalControls(field.error), MAX_CONTENT_ERROR_BYTES) } : {}),
      };
    }),
  };

  const content: FillFormContentBlock[] = [
    { type: "text", text: summary },
    { type: "text", text: JSON.stringify(report) },
  ];
  if (partiallyApplied) {
    content.push({
      type: "text",
      text: "The failing fill ended with outcome=unknown: it may have partially applied — re-observe the page before retrying anything.",
    });
  }

  return {
    content,
    details: {
      tabId,
      status,
      filled,
      failed,
      notAttempted,
      ...(issue ? { issue } : {}),
      ...(partiallyApplied ? { partiallyApplied: true } : {}),
      ...(pageInfo ? { pageInfo } : {}),
      fields: fields.map((field) => {
        return { selector: field.selector, status: field.status, ...(field.error ? { error: field.error } : {}) };
      }),
    },
  };
}

/**
 * Fill one form: resolve every selector, then fill field by field.
 *
 * Resolution failures are aggregated (ALL failing selectors are reported) and
 * fill NOTHING. A fill failure stops the batch — the page is no longer the state
 * the remaining selectors were resolved against, so they are reported as
 * `not-attempted` rather than chained blindly. A transport failure during
 * resolution — or the relay refusing the probe itself — throws (nothing was
 * filled and nothing else could run); a transport failure during fills is
 * reported per field instead, so the caller still learns which fields were
 * already written. The resolve pass is bounded by `resolveBudgetMs`: once it is
 * exceeded, the fields that were never probed are reported with the budget as
 * their error instead of waiting out every selector timeout.
 */
export async function fillForm(options: {
  client: BrowserRuntimeClient;
  sessionId: string;
  cwd: string | undefined;
  signal: AbortSignal | undefined;
  /** Pi toolCallId: every op derives its own unique requestId from it. */
  toolCallId: string;
  tabId: string;
  fields: FillFormField[];
  /** Internal: overrides DEFAULT_RESOLVE_BUDGET_MS for this batch (tests, callers). */
  resolveBudgetMs?: number;
}): Promise<{ content: FillFormContentBlock[]; details: Json }> {
  const { client, sessionId, cwd, signal, toolCallId, tabId, fields } = options;
  const resolveBudgetMs = options.resolveBudgetMs ?? DEFAULT_RESOLVE_BUDGET_MS;

  const validation = validateFillFormFields({ fields });
  if (!validation.ok) {
    return buildReport({
      tabId,
      status: "rejected",
      issue: validation.problem,
      fields: fields.map((field) => {
        return { selector: field.selector, status: "not-attempted" as const };
      }),
    });
  }

  const call = ({
    index,
    phase,
    operation,
  }: {
    index: number;
    phase: "resolve" | "fill";
    operation: BrowserOperation;
  }): Promise<BrowserResultData> => {
    return callOperation({
      client,
      sessionId,
      cwd,
      signal,
      requestId: `${toolCallId}:fill-form:${phase}:${index + 1}`,
      operation,
    });
  };

  // 1) Resolve every selector before the first fill. The probe is a strict
  // single-match read through the same path page.fill uses; zero or multiple
  // matches is a failure, and ANY failure means nothing gets filled.
  const resolutionFailures = new Map<number, string>();
  let pageInfo: Json | undefined;
  const resolveStartedAt = Date.now();
  for (const [index, field] of fields.entries()) {
    // After the first probe, a batch that keeps burning time on selectors it may
    // never fill is cut off: the fields not reached are reported honestly as
    // un-probed instead of inheriting a per-field timeout each.
    if (index > 0 && Date.now() - resolveStartedAt > resolveBudgetMs) {
      const budgetError = `resolution stopped early: exceeded the ${formatResolveBudget(resolveBudgetMs)} batch resolve budget`;
      for (let remaining = index; remaining < fields.length; remaining++) {
        resolutionFailures.set(remaining, budgetError);
      }
      break;
    }
    try {
      const data = await call({
        index,
        phase: "resolve",
        operation: { kind: "page.extract", tabId, format: "html", selector: field.selector },
      });
      if (!pageInfo && isRecord(data.pageInfo)) pageInfo = data.pageInfo;
    } catch (e) {
      // Not a fact about this selector: nothing in the batch can resolve while
      // the runtime is unreachable, the exchange timed out, or the relay refuses
      // the probe itself (`unsupported-capability` on a profile/backend that has
      // no page.extract), and nothing has been filled yet — fail the call with
      // the real cause instead of blaming every field.
      if (isTransportFailure(e) || (e instanceof RuntimeRequestError && e.code === "unsupported-capability")) {
        throw new Error(
          `browser_fill_form filled nothing: resolving field ${index + 1} ("${preview(field.selector, 60)}") failed — ${describeFailure(e)}`,
          { cause: e },
        );
      }
      resolutionFailures.set(index, describeFailure(e));
    }
  }
  if (resolutionFailures.size > 0) {
    return buildReport({
      tabId,
      status: "rejected",
      issue: `${resolutionFailures.size} of ${fields.length} selector(s) did not resolve to exactly one element`,
      fields: fields.map((field, index) => {
        const error = resolutionFailures.get(index);
        return { selector: field.selector, status: error ? ("failed" as const) : ("not-attempted" as const), ...(error ? { error } : {}) };
      }),
      ...(pageInfo ? { pageInfo } : {}),
    });
  }

  // 2) One deterministic fill per field, in order, with the plain selector (no
  // snapshotId). The first failure stops the batch.
  const outcomes: FillFormFieldOutcome[] = [];
  let stopped = false;
  let partiallyApplied = false;
  for (const [index, field] of fields.entries()) {
    if (stopped) {
      outcomes.push({ selector: field.selector, status: "not-attempted" });
      continue;
    }
    try {
      const data = await call({
        index,
        phase: "fill",
        operation: { kind: "page.fill", tabId, selector: field.selector, value: field.value },
      });
      if (!pageInfo && isRecord(data.pageInfo)) pageInfo = data.pageInfo;
      outcomes.push({ selector: field.selector, status: "filled" });
    } catch (e) {
      if (e instanceof RuntimeRequestError && e.outcome === "unknown") partiallyApplied = true;
      outcomes.push({ selector: field.selector, status: "failed", error: describeFailure(e) });
      stopped = true;
    }
  }

  const filled = outcomes.filter((outcome) => outcome.status === "filled").length;
  const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
  const status: FillFormStatus = failed === 0 ? "filled" : filled > 0 ? "partial" : "failed";
  return buildReport({
    tabId,
    status,
    fields: outcomes,
    ...(partiallyApplied ? { partiallyApplied } : {}),
    ...(pageInfo ? { pageInfo } : {}),
  });
}
