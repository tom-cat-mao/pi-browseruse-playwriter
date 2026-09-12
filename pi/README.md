# @tom-cat/pi-browser-use-extension

Pi extension that drives the **user's real Chrome or Firefox** (their real login sessions)
through a paired **managed browser runtime** (`@tom-cat/pi-browser-runtime`).
No new browser is launched by the extension, no cloud — the tools speak a frozen
HTTP v1 contract to a local runtime that owns the browser connection.

The extension only executes and reports facts; the Pi LLM owns every decision.
There is no agent loop, HITL, captcha, or danger-confirmation logic here.

## Requirements

- **Pi** (`@earendil-works/pi-coding-agent`)
- The **managed browser runtime** on `127.0.0.1:19989` (default). It is started
  automatically on first tool use (see *How it works*); inspect it any time with
  `/browser-status`.
- **Chrome or Firefox** connected to the runtime as a profile (`browser_profiles` must show
  a `connected` profile before you can open groups/tabs).
- Firefox uses the ordinary add-on's DOM backend; development loading and its
  signing/compatibility status are described in the [Firefox guide](../docs/exec/firefox-extension-guide.md).

## Configuration

| Env | Meaning | Default |
|---|---|---|
| `PI_BROWSER_HOST` | runtime host (bare host or full `http(s)://…`) | `127.0.0.1` |
| `PI_BROWSER_PORT` | runtime port | `19989` |
| `PI_BROWSER_TOKEN` | bearer token, if the runtime requires auth | none |
| `PI_BROWSER_RUNTIME_PATH` | absolute path to a runtime-cli entry to launch (`.ts` via `tsx`, else `node`) | packaged `pi-browser-runtime` bin |

A non-loopback `PI_BROWSER_HOST` is treated as a remote runtime: the extension
will **not** try to spawn a local daemon for it. `npx playwriter@latest` is never
used.

## Tools

| Tool | Purpose |
|---|---|
| `browser_profiles` | list browser profiles, connection state, and actual backend capabilities (needed for `profileId`) |
| `browser_groups` | list/create/rename/close this session's tab groups (create needs `name`+`profileId`) |
| `browser_tabs` | list/create/attach/activate/close/release tabs; `discover` lists real open tabs with Pi-side `offset`/`limit` paging (active tabs first, `nextOffset`/`truncated` reported) |
| `browser_navigate` | navigate a `tabId` to a URL, or `action:"back"` through real browser history |
| `browser_snapshot` | accessibility tree for a `tabId` with `aria-ref=eN` refs + `snapshotId` (default readable tree; `full` requests the complete tree, output bounded) |
| `browser_click` | click by ref (`aria-ref=eN`/`@eN` + `snapshotId`) or strict CSS |
| `browser_fill` | set input/textarea/contenteditable text (clear-and-insert) |
| `browser_evaluate` | run JS against a tab's DOM (`document`/`window`, async; isolated world on Firefox) |
| `browser_screenshot` | screenshot a tab (inline image, optional `path`/`fullPage`/`labels`) |
| `browser_network` | capture/list/stop a tab's network responses; retained entries and capture state survive stop/interruption |
| `browser_logs` | buffered console/log output for a tab |
| `browser_execute` | escape hatch: Playwright snippet bound to a tab's `page`; Firefox provides a DOM-compatible subset |

Also registers the inspect-only `/browser-status` command (reachability,
capabilities, connected profiles). There is no `browser_save_as_pdf` — it always
errored on headed extension sessions.

## Firefox capability differences

The same structured tools address Chrome and Firefox by explicit `profileId`
and `tabId`. `browser_profiles` puts optional backend metadata into the model's
**content**, including `backend`, `inputMode`, `snapshotMode`, `executeMode`,
`evaluateWorld`, `supportedOperations`, and `limitations`. Older Chrome profiles
can omit these fields. The compact human row marks a Firefox profile as using
DOM input; ordinary actions do not repeat a long warning.

Firefox profiles report `webextension` / `dom` / `dom-aria` / `dom-compatible`
/ `isolated`. Input is performed through DOM APIs, so sites that require
trusted native keyboard or pointer events can behave differently. Snapshots
use DOM accessibility semantics rather than Chrome's native AX tree.
`browser_evaluate` can read and change DOM but does not expose page-script
globals as if it were Chrome's main world; code must explicitly return a value.
Firefox evaluate requires Firefox 153+ and the optional page-JavaScript
permission, enabled by the user in the add-on popup. Without it, the basic
DOM tools remain available and evaluate reports `unsupported-capability`.
`browser_execute` supports documented page/locator methods and fails explicitly
for unsupported APIs, including CDP and browser/context creation or closure.

Firefox execute provides `page.keyboard.press/type` as DOM helpers targeting
the selected tab's strict `:focus` match. They do not send native keyboard
input. Chrome execute does not expose `keyboard`; `mouse`/`touchscreen` remain
unsupported on both backends, as do Firefox keyboard methods such as `down/up`.

Firefox supports `waitForURL`, `waitForLoadState`, `waitForFunction`,
`waitForSelector`, and `setDefaultTimeout`. Wait timeouts default to 5000 ms,
accept 1–5000 ms, and remain subject to the overall execute deadline.
`waitForFunction` requires the optional evaluate capability and returns a
plain value. Snapshot refs in execute also require a `snapshotId`;
`refToLocator` produces a selector carrying that snapshot binding.

After evaluate or execute, acquire a new snapshot before using refs again on
either backend. An unsupported operation or unknown outcome is returned as a
typed error; it is never silently retried through another browser.

## Human-facing rows

Tool rows are designed to be read, not skimmed:

- The folded row shows the observed page (title — domain) plus the action and
  verifiable counts/outcome; when no page is known yet it falls back to a short
  tail of the opaque id. Full ids always stay in the model-visible content and in
  the expanded detail.
- Page context is remembered per Pi session from the page facts the runtime
  already returned (a created/attached tab, a listing, or an optional
  `pageInfo` observation). It is bounded, never triggers an extra browser call,
  and is dropped on session shutdown — one session never shows another session's
  titles.
- Real ANSI/terminal control sequences are stripped before any shortening, with
  Unicode/wide-character safe truncation; opaque ids are never rewritten.
- Expanded success detail is byte-bounded (no unlimited raw dump) and errors
  show the complete bounded multiline message with `code`/`outcome`; collapsed
  errors keep the first line plus an expand affordance.
- Screenshot images are still rendered by the framework from the result content;
  the custom row only adds the saved path/image count.

`browser_tabs discover` paginates in the Pi extension only: the full
`tabs.discover` response is sorted active-first (window focus as tie-break) and
paged locally, so `offset`/`limit` are never sent to the runtime. The result
reports `total`/`returned`/`nextOffset`/`truncated`, and `nextOffset` counts the
candidates actually returned even when the byte budget cuts a page short.

## Resource & identity model

- **Identity is automatic.** Every request carries the full Pi session UUID from
  `ctx.sessionManager.getSessionId()`. It is never an LLM parameter and never a
  cached module-global, so `/new`, `/resume`, `/fork`, `/reload` each get their
  own id with no stale carry-over.
- **requestId is the Pi toolCallId.** A retried create with the same id returns
  the original resource (idempotency is enforced by the runtime).
- One Pi session : N named groups; each group is bound to one fixed profile.
  All page tools take an explicit `tabId` — there is no implicit "current page"
  and no URL/title heuristics to reach another session's resources.
- `browser_groups list` / `browser_tabs list` are filtered by the runtime
  strictly to this session.

## How it works

- The first tool call probes `GET /browser/v1/capabilities`. If a managed v1
  runtime answers, it is used as-is. If the loopback port is genuinely free, the
  extension launches the paired runtime once (detached) and waits for it to come
  up. A slow/timing-out, token-protected (401), or non-managed listener is a hard
  error — the extension never launches over, nor replaces, a process it does not
  own.
- Requests are `POST /browser/v1/request` (`BrowserRequest` → `BrowserResponse`).
  Responses are validated at runtime (not just typed): protocol version must be
  `1`, managed capabilities must be advertised, and result payloads are
  size-bounded. Business failures (`ok:false`) preserve the runtime's error
  `code` and `outcome` so the LLM can reason about partial effects.
- Structured resources (group/tab ids, `snapshotId`, evaluate values, listings)
  are serialized into the tool **content** the LLM sees — not just `details`
  (which Pi keeps for UI only). Text and inline images are capped.
- On cancellation the extension fires a separate best-effort `request.cancel`
  with a fresh signal; page actions are never retried or replayed. An aborted
  mutating request reports `outcome: "unknown"`.
- Deadlines are split: the operation `timeoutMs` (capped at 120s) is what the
  runtime enforces, while the client transport waits one bounded grace past it so
  the runtime can return its typed `timeout` result instead of a raw socket
  abort. A user abort is immediate and independent of that grace, applies through
  the whole body read, and cancellation is a separate request.
- `session_shutdown` calls `session.release` only — it frees this session's
  workers/CDP clients but never deletes groups/tabs and never stops the shared
  runtime. Session-scoped page context is dropped at the same time.

## Development

```bash
pnpm --filter @tom-cat/pi-browser-use-extension test        # vitest (real local HTTP server)
pnpm --filter @tom-cat/pi-browser-use-extension typecheck    # tsc --noEmit
pnpm --filter @tom-cat/pi-browser-use-extension load-check   # jiti load + registration assert
```

Tests use a real `node:http` server (no mocked `fetch`) to exercise the wire
contract, response validation, output bounds, lifecycle, and result shaping.
None of them start a browser or a real runtime.

Runtime dependencies: the type-only `@tom-cat/pi-browser-runtime/browser-protocol`
export plus Pi packages (`@earendil-works/*`, `typebox`); at runtime only global
`fetch` + node built-ins are used.
