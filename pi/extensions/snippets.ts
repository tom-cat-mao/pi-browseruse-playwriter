/**
 * Pure Playwright-code generators for the relay `/cli/execute` endpoint.
 *
 * Every snippet runs inside the playwriter executor sandbox, which exposes:
 *   - `page`, `context` (playwright objects)
 *   - `state` (persisted across execute calls, per relay session)
 *   - `snapshot({ page, search?, showDiffSinceLastCall? })`
 *   - `getLatestLogs({ page, sinceLastCall?, search? })`
 *   - `refToLocator({ ref })` -> selector string for a snapshot ref, or null
 *
 * These functions are pure (string in, string out) so they are unit-testable
 * without a browser. Output is streamed through `console.log`, which the relay
 * returns as `{ text, images, screenshots, isError }`.
 *
 * Quoting: values are embedded with JSON.stringify (valid JS string literals),
 * so there is no shell-escaping problem — the snippet travels in a JSON body.
 */

/** JS string literal from a value (JSON.stringify output is valid JS). */
export const jsString = (v: string): string => JSON.stringify(v);

/**
 * Normalize a user-provided selector:
 *   - `@eN` (webbridge-style) -> `aria-ref=eN`
 *   - `aria-ref=eN` -> unchanged (snapshot refs from playwriter snapshots)
 *   - anything else -> treated as a CSS selector
 */
export function normalizeSelector(selector: string): string {
  const s = selector.trim();
  if (s.startsWith("@")) {
    return `aria-ref=${s.slice(1)}`;
  }
  return s;
}

/**
 * Expression resolving a normalized selector to a Playwright locator string.
 * `aria-ref=` refs must be resolved through `refToLocator` because the short
 * ref only exists in the latest snapshot; the helper maps it to a real
 * selector (role=..., [data-testid=...], ...).
 */
export function resolveLocatorExpression(selector: string): string {
  const sel = normalizeSelector(selector);
  if (sel.startsWith("aria-ref=")) {
    const ref = sel.slice("aria-ref=".length);
    return `(() => {
  const __ref = ${jsString(ref)};
  const __loc = refToLocator({ ref: __ref });
  if (!__loc) throw new Error('[pi] ref ${jsString(ref)} not found in the latest snapshot — call browser_snapshot first');
  return __loc;
})()`;
  }
  return jsString(sel);
}

const LOGS_LINE = `console.log('Page logs:', await getLatestLogs({ page: state.page, sinceLastCall: true }))`;

export interface NavigateArgs {
  url: string;
  newTab?: boolean;
}

/** state.page = newTab ? await context.newPage() : page; await state.page.goto(url) */
export function navigateSnippet({ url, newTab }: NavigateArgs): string {
  const target = newTab ? "await context.newPage()" : "page";
  return `state.page = ${target};
await state.page.goto(${jsString(url)}, { waitUntil: 'domcontentloaded' });
state._piOpened = state._piOpened ?? [];
if (!state._piOpened.includes(${jsString(url)})) state._piOpened.push(${jsString(url)});
console.log('URL:', state.page.url());
console.log('TITLE:', await state.page.title());
${LOGS_LINE}`;
}

/** console.log(await snapshot({ page: state.page })) */
export function snapshotSnippet(): string {
  return `console.log(await snapshot({ page: state.page }))`;
}

export interface ClickArgs {
  selector: string;
}

export function clickSnippet({ selector }: ClickArgs): string {
  return `const __loc = ${resolveLocatorExpression(selector)};
await state.page.locator(__loc).first().click();
console.log('CLICKED:', ${jsString(selector)});
console.log('URL:', state.page.url());
${LOGS_LINE}`;
}

export interface FillArgs {
  selector: string;
  value: string;
}

/** Clear-and-insert: .fill() replaces existing content. */
export function fillSnippet({ selector, value }: FillArgs): string {
  return `const __loc = ${resolveLocatorExpression(selector)};
await state.page.locator(__loc).first().fill(${jsString(value)});
console.log('FILLED:', ${jsString(selector)});
console.log('URL:', state.page.url());
${LOGS_LINE}`;
}

export interface EvaluateArgs {
  code: string;
}

/**
 * Run user code inside the page via page.evaluate (DOM available, async ok).
 * Wrapped in an async arrow so `const`/`let` stay scoped. Result is printed
 * with a `RESULT:` marker so the pi layer can parse it back into structured
 * data. Sandbox-scope access (state/context/require) is not available here —
 * use browser_execute for that.
 */
export function evaluateSnippet({ code }: EvaluateArgs): string {
  return `const __pi_result = await state.page.evaluate(async () => {
${code}
});
console.log('RESULT:' + JSON.stringify(__pi_result));`;
}

export interface ScreenshotArgs {
  path?: string;
  fullPage?: boolean;
}

/**
 * Two captures:
 *   1. `state.page.screenshot({ path, fullPage })` writes the user-requested
 *      file (path must be absolute, under an allowed dir: session cwd, /tmp).
 *   2. `screenshotWithAccessibilityLabels` feeds the relay's image/screenshot
 *      collectors, so the pi layer receives an inline base64 image plus a
 *      labeled PNG path, label count and aria snapshot.
 */
export function screenshotSnippet({ path, fullPage }: ScreenshotArgs): string {
  const opts = JSON.stringify({ path: path ?? undefined, fullPage: fullPage ?? undefined, scale: "css" });
  return `const __shot = await state.page.screenshot(${opts});
if (__shot && typeof __shot === 'object' && !ArrayBuffer.isView(__shot)) {
  console.log('SHOT_PATH:', __shot.path ?? '');
}
await screenshotWithAccessibilityLabels({ page: state.page });
console.log('URL:', state.page.url());
${LOGS_LINE}`;
}

export interface TabsListArgs {
  active?: boolean;
}

/** Enumerate context pages with url/title/active flags; parseable `TABS:` line. */
export function tabsListSnippet(_args: TabsListArgs): string {
  return `const __pages = await Promise.all(context.pages().map(async (p, i) => ({
  index: i,
  url: p.url(),
  title: await p.title(),
  isCurrent: p === state.page,
})));
console.log('TABS:' + JSON.stringify(__pages));`;
}

export interface TabsFindArgs {
  url?: string;
  active?: boolean;
}

/** Switch `state.page` to the tab matching url, or the most recent tab when active:true. */
export function tabsFindSnippet({ url, active }: TabsFindArgs): string {
  if (url) {
    return `const __target = context.pages().find((p) => p.url().startsWith(${jsString(url)}))
  ?? context.pages().find((p) => p.url().includes(${jsString(url)}));
if (!__target) {
  throw new Error('[pi] no tab found matching ' + ${jsString(url)} + ' — use browser_tabs list first');
}
state.page = __target;
console.log('SWITCHED:', state.page.url());`;
  }
  if (active === true) {
    return `const __pages = context.pages();
if (__pages.length === 0) {
  throw new Error('[pi] no tabs attached — toggle the Playwriter extension on a tab first');
}
state.page = __pages[__pages.length - 1];
console.log('SWITCHED:', state.page.url());`;
  }
  return `throw new Error('[pi] browser_tabs find requires a url or active:true')`;
}

/** Close the current `state.page`; reset it so a later navigate starts fresh. */
export function tabsCloseTabSnippet(): string {
  return `if (state.page) {
  const __url = state.page.url();
  await state.page.close();
  state.page = null;
  console.log('CLOSED:', __url);
} else {
  console.log('CLOSED: (no current tab)');
}`;
}

/**
 * Close the tabs this session opened (tracked in state._piOpened). The relay's
 * shared context can contain other sessions'/the user's tabs, so never close
 * pages we did not open. When the relay gains the closeTabs capability (B
 * workstream) the relay-side endpoint handles scoping instead.
 */
export function tabsCloseSessionSnippet(): string {
  return `const __opened = state._piOpened ?? [];
const __targets = context.pages().filter((p) => __opened.some((u) => p.url().startsWith(u)));
const __count = __targets.length;
await Promise.all(__targets.map((p) => p.close()));
state.page = null;
console.log('CLOSED_SESSION:', __count);`;
}

export interface NetworkStartArgs {
  filter?: string;
}

/**
 * Attach a named response listener stored on `state` so it can be removed
 * later without nuking listeners other agents attached. Requests collected
 * on `state._reqs` survive across execute calls (session state).
 */
export function networkStartSnippet(): string {
  return `state._reqs = state._reqs ?? [];
if (!state._piOnResponse) {
  state._piOnResponse = (__r) => {
    state._reqs.push({ url: __r.url(), status: __r.status(), type: __r.request().resourceType() });
  };
  state.page.on('response', state._piOnResponse);
}
console.log('NET_START: capturing responses on ' + state.page.url());`;
}

export interface NetworkListArgs {
  filter?: string;
}

export function networkListSnippet({ filter }: NetworkListArgs): string {
  const filterExpr = filter ? `(state._reqs ?? []).filter((r) => r.url.includes(${jsString(filter)}))` : "(state._reqs ?? [])";
  return `console.log('NET:' + JSON.stringify(${filterExpr}));`;
}

export function networkStopSnippet(): string {
  return `if (state._piOnResponse) {
  state.page.off('response', state._piOnResponse);
  state._piOnResponse = undefined;
}
state._reqs = [];
console.log('NET_STOP: capture stopped');`;
}

export interface PdfArgs {
  path?: string;
  format?: string;
  landscape?: boolean;
}

export function pdfSnippet({ path, format, landscape }: PdfArgs): string {
  const opts = JSON.stringify({ path: path ?? undefined, format: format ?? undefined, landscape: landscape ?? undefined });
  return `await state.page.pdf(${opts});
console.log('PDF_PATH:', ${jsString(path ?? "(in-memory buffer)")});`;
}

/** Escape hatch: raw passthrough snippet, unchanged. */
export function rawSnippet(code: string): string {
  return code;
}
