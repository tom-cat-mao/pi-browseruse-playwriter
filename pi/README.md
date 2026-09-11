# @tom-cat/pi-browser-use-extension

Pi extension that drives the **user's real Chrome** (their real login sessions)
through a paired **managed browser runtime** (`@tom-cat/pi-browser-runtime`).
No new browser is launched by the extension, no cloud — the tools speak a frozen
HTTP v1 contract to a local runtime that owns the Chrome connection.

The extension only executes and reports facts; the Pi LLM owns every decision.
There is no agent loop, HITL, captcha, or danger-confirmation logic here.

## Requirements

- **Pi** (`@earendil-works/pi-coding-agent`)
- The **managed browser runtime** on `127.0.0.1:19989` (default). It is started
  automatically on first tool use (see *How it works*); inspect it any time with
  `/browser-status`.
- **Chrome** connected to the runtime as a profile (`browser_profiles` must show
  a `connected` profile before you can open groups/tabs).

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
| `browser_profiles` | list Chrome profiles + connection state (needed for `profileId`) |
| `browser_groups` | list/create/rename/close this session's tab groups (create needs `name`+`profileId`) |
| `browser_tabs` | list/create/attach/activate/close/release tabs; `discover` lists real open tabs with Pi-side `offset`/`limit` paging (active tabs first, `nextOffset`/`truncated` reported) |
| `browser_navigate` | navigate a `tabId` to a URL, or `action:"back"` through real browser history |
| `browser_snapshot` | accessibility tree for a `tabId` with `aria-ref=eN` refs + `snapshotId` (default is the readable tree, `full` the unfiltered tree) |
| `browser_click` | click by ref (`aria-ref=eN`/`@eN` + `snapshotId`) or strict CSS |
| `browser_fill` | set input/textarea/contenteditable text (clear-and-insert) |
| `browser_evaluate` | run JS in a tab's page (`document`/`window`, async) |
| `browser_screenshot` | screenshot a tab (inline image, optional `path`/`fullPage`/`labels`) |
| `browser_network` | capture/list/stop a tab's network responses; retained entries and capture state survive stop/interruption |
| `browser_logs` | buffered console/log output for a tab |
| `browser_execute` | escape hatch: Playwright snippet bound to a tab's `page` |

Also registers the inspect-only `/browser-status` command (reachability,
capabilities, connected profiles). There is no `browser_save_as_pdf` — it always
errored on headed extension sessions.

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
None of them start Chrome or a real runtime.

Runtime dependencies: the type-only `@tom-cat/pi-browser-runtime/browser-protocol`
export plus Pi packages (`@earendil-works/*`, `typebox`); at runtime only global
`fetch` + node built-ins are used.
