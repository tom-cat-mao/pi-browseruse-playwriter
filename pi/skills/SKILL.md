# Browser Use (Playwriter relay) — usage discipline

You can drive the user's real Chrome (their login sessions) through the
`browser_*` tools. These talk to the user's own browser via the Playwriter
extension + local relay — no new browser is launched, cookies/logins are the
user's real ones.

## When to use

- Use `browser_*` when the task needs a real browser: JS-heavy sites,
  logged-in pages, forms, cookie walls, screenshots of actual layout.
- Prefer `browser_snapshot` (text) over `browser_screenshot` (visual) to read
  page state — it is fast, cheap and gives you refs for the other tools.
- Only touch the user's browser when the task calls for it. Do not open
  unrelated tabs. Every tab you open should be cleaned up with
  `browser_tabs close_session` (or close_tab) at the end.

## Core loop: observe → act → observe

Never chain actions blindly. For every step:

1. `browser_navigate` (pass `newTab: true` on the first navigate of a task so
   the task gets its own tab; `group_title` labels the tab group when the
   relay supports session groups).
2. `browser_snapshot` to read the page. Pages redirect unexpectedly — always
   check the URL in the result.
3. Act with one tool (`browser_click`, `browser_fill`, ...).
4. `browser_snapshot` / `browser_evaluate` again to verify the effect. If the
   page did not change, you clicked the wrong thing or it is still loading —
   wait and re-observe instead of clicking again.

## Selectors: refs over CSS

- The snapshot returns `aria-ref=eN` refs. Pass them straight to
  `browser_click`/`browser_fill` (the `@eN` shorthand also works).
- Refs are only valid against the **latest** snapshot. If the page changed,
  take a fresh `browser_snapshot` before clicking — stale refs throw.
- Avoid hand-written CSS selectors; use refs from the snapshot.
- If a selector matches multiple elements the click hits `.first()`; when you
  need a specific one, re-snapshot and use its ref.

## After every action: check console logs

The executor buffers page console output. After goto/click/submit, look at
the `Page logs:` lines in the result — they surface hydration errors, failed
requests and runtime exceptions without you attaching any listeners.

## Filling forms

- `browser_fill` is clear-and-insert: existing content is replaced.
- To append, read the current value with `browser_evaluate`, concatenate, then
  `browser_fill` the result.
- Prefer filling the focused input; click the field first if the page needs a
  click to open an editor (contenteditable/ProseMirror-style).

## Waiting and timeouts

- Prefer proper waits over sleeps: `browser_execute` with
  `await state.page.waitForSelector(...)` or
  `await state.page.waitForLoadState('domcontentloaded')`.
- For SPA navigations use
  `await state.page.waitForResponse(url => url.includes('api/'), { timeout: 10000 })`.
- Short sleeps (1-2s) are acceptable for non-deterministic UI (animations,
  async updates) where no selector exists. `browser_execute` accepts `timeout`
  (ms) for long-running snippets.

## browser_execute (escape hatch)

The sandbox scope has `page`, `context`, `state` (persistent across calls),
`snapshot`, `getLatestLogs`, `refToLocator`. Use it for things the typed tools
don't cover (iframes, multi-step flows, custom waits).

- `state` persists per relay session — store your page as `state.page`, reuse
  it across calls.
- Never call `browser.close()` / `context.close()`. Close tabs with
  `browser_tabs`.
- Wrap multi-statement code in an IIFE: `const`/`let` redeclared across calls
  throws. Results print on a `RESULT:` line as compact JSON.

## Quoting and escaping

The pi tools send code as JSON — there is **no shell quoting layer**, so
single quotes, `$`, backticks inside snippets are safe. Just keep JS strings
consistent (`'...'` or `"..."` as you like).

## Network capture

`browser_network start` before the action that triggers requests, then
`browser_network list` with a url substring `filter` to inspect API calls.
Capture persists in session state across calls; `stop` clears it.

## Screenshots and PDFs

- `browser_screenshot` returns an inline labeled image when your model can
  see images, plus the saved file path.
- `browser_save_as_pdf` only works on headless/direct-CDP sessions; in
  extension mode (headed Chrome) it errors — use `browser_screenshot`.

## Session hygiene

- The session binds once per pi session as `pi-<id8>` on the relay.
- **Always** close the session's tabs when done:
  `browser_tabs close_session` (or `close_tab` per tab). The relay session is
  deleted automatically on pi session shutdown.
- If a tool reports the session is gone, it is recreated automatically on the
  next call — just retry.
