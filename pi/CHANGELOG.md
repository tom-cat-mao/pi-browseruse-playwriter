# @tom-cat/pi-browser-use-extension

## 0.2.0

### Minor Changes

- 859910d: Add a managed browser protocol for Pi sessions with explicitly named groups, profile-bound resources, and tab-scoped operations. Separate persistent resource ownership from transient browser connections and execution sessions.
- 61456ba: Continue in the tab the user is already looking at, and come back after reading a link.

  **Discover and attach existing tabs in place.** `tabs.discover` lists the real tabs of every connected profile — profile, window, URL, title, whether it is the active tab of its window and whether that window has focus — and `tabs.attach` takes control of the chosen one where it is. Nothing is reloaded, moved, regrouped or reopened: scroll position, form state and the user's existing Chrome groups survive. Only the chosen tab is attached, never the rest of its Chrome group, and tabs another session controls are refused. Each attached tab gets a normal `tabId`, so every existing page tool works on it; no group has to be created first.

  ```jsonc
  // browser_tabs action:"discover" (optionally query / windowId / profileId)
  { "candidateId": "pcdt:profile-1:epoch-a:7", "windowId": 3, "title": "Invoice draft", "active": true }
  // browser_tabs action:"attach" with that candidateId -> { "tab": { "tabId": "ptab_…", "origin": "existing" } }
  ```

  **Follow an external link and come back.** A tab opened by `target=_blank` / `window.open` records the managed tab it came from, so `browser_tabs list` with `sourceTabId` finds the real new tab instead of guessing by URL or "the last tab". A tab attached in place keeps its child tabs where Chrome put them — same window, same groups, no popup relocation — while task groups keep their existing "popup joins the group" behaviour. `browser_tabs action:"activate"` brings the original tab back to the front, and `browser_navigate action:"back"` uses real browser history instead of re-navigating the old URL; when the browser reports no navigation response (same-document/SPA history entries) the result says so instead of claiming nothing happened.

  All of this works with the text accessibility tree: reading, clicking, filling and going back need no screenshots.

- 6dcde8e: Rewrite the Pi browser tools onto the managed runtime HTTP v1 contract. The extension now talks to `@tom-cat/pi-browser-runtime` (default `127.0.0.1:19989`) over the frozen `BrowserRequest`/`BrowserResponse` protocol instead of the legacy playwriter relay on 19988.
  - Explicit resource model: `browser_profiles`, `browser_groups` (list/create/rename/close), `browser_tabs` (list/create/close/release) plus tab-scoped `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_evaluate`, `browser_screenshot`, `browser_network`, `browser_logs`, `browser_execute`. No implicit current page; all page ops take an explicit `tabId`.
  - Identity is automatic: every request carries the full Pi session UUID from `ctx.sessionManager.getSessionId()` (never an LLM parameter, never a stale module-global). `requestId` is the Pi toolCallId for idempotent creates.
  - Structured resources (group/tab ids, `snapshotId`, evaluate values, listings) are serialized into tool content so the LLM can continue; text and inline images are bounded, and runtime responses are validated (protocol v1, managed capabilities, sizes).
  - Runtime is launched once on first use via `PI_BROWSER_RUNTIME_PATH` or the packaged `pi-browser-runtime` bin (never npx); a slow/token-protected/foreign or remote listener is never replaced. Configurable via `PI_BROWSER_HOST`/`PI_BROWSER_PORT`/`PI_BROWSER_TOKEN`.
  - Cancellation fires a separate best-effort `request.cancel`; aborted mutating requests report `outcome: "unknown"` and are never replayed. `session_shutdown` calls `session.release` only. `/browser-status` is inspect-only. Removed the always-erroring `browser_save_as_pdf`.

- bf416aa: Expose per-profile browser backend capabilities and limitations to Pi models, validate the optional Firefox metadata, and document the ordinary Firefox extension's DOM input, isolated evaluate, and compatible execute behavior.

### Patch Changes

- 6595df2: Harden the managed browser tools' output bounding and cancellation edges.
  - Output budgets are now measured in UTF-8 bytes (not characters), so multibyte content such as thousands of Chinese group names or long URLs is capped at its true size and truncation markers are counted against the budget. Byte-truncation snaps to a code-point boundary so an emoji is never split into a replacement character, and a truncation marker is only appended when it fits within the remaining budget.
  - Large listings (groups/tabs/profiles) are truncated item-by-item into valid, parseable JSON with a `${key}Truncated` count instead of emitting the full giant array or slicing the JSON into an invalid string. Room for every list's key and count marker is reserved up front so a combined profiles+groups+tabs listing stays within budget. Free-form display fields (group name, tab url/title, profile label) are individually clamped, so a single resource with a huge title/url can never overflow the block or drop its `tabId`/`groupId`/`snapshotId`. An oversize evaluate `value` is emitted as an explicitly-truncated string sized from its real header/footer byte cost.
  - `ensureRuntime(signal)` removes its abort listener once the launch race settles, so a caller cancelling during a shared launch no longer leaks a listener on the long-lived signal.
  - Clarified `browser_tabs` release, `browser_execute`, and the skill docs: release relinquishes this session's control (the runtime never re-opens tabs on its own); `browser_execute` calls are independent (no reusing page/locator/CDP handles across calls), must await all actions and leave no background timers, and keyboard/mouse/touchscreen input is unsupported for now.

- 67a046d: Readable browser tool rows, Pi-side discover paging, and a typed-timeout transport grace.

  **Human-facing rows.** Folded rows lead with the observed page (title — domain), the action and verifiable counts; opaque ids stay complete in model-visible content and expanded detail, with a short id tail as fallback. Real ANSI/terminal control sequences are stripped before shortening (Unicode/wide-character safe), expanded success detail is byte-bounded instead of dumping raw details, and errors show the complete bounded multiline message with `code`/`outcome` when expanded plus an expand affordance when collapsed. `browser_execute` reports its value and logs, `browser_network stop` reports capture state and retained/dropped counts, history `back` is visible even without a URL, and screenshot images keep rendering through the framework.

  **Per-session page context.** Page facts the runtime already returned (a created/attached tab, a listing, or a `pageInfo` observation) are cached per Pi session, bounded and cleared on session shutdown — no extra browser calls and no cross-session titles.

  **Discover pagination.** `browser_tabs discover` pages locally with optional `offset`/`limit` (default 20): active tabs first, window focus as tie-break, `total`/`returned`/`nextOffset`/`truncated` reported. `nextOffset` counts the candidates actually returned, so a byte-budget cut never skips an unseen tab, and no new field is sent over the wire.

  **Typed-timeout transport grace.** The operation `timeoutMs` (runtime cap 120s) stays distinct from a bounded transport grace, so the runtime can return its typed `timeout` result instead of a raw socket abort. A user abort stays immediate, applies through the whole body read, and cancellation remains a separate request with no automatic replay.

- Updated dependencies [f963175]
- Updated dependencies [859910d]
- Updated dependencies [300fc74]
- Updated dependencies [102c4c9]
- Updated dependencies [534080b]
- Updated dependencies [61456ba]
- Updated dependencies [a6cc285]
- Updated dependencies [25d7a33]
- Updated dependencies [ec3e1ca]
- Updated dependencies [fee60a9]
- Updated dependencies [7d0f92b]
- Updated dependencies [b53637a]
- Updated dependencies [64214b3]
- Updated dependencies [0e4867a]
- Updated dependencies [2a43124]
- Updated dependencies [84ab1aa]
- Updated dependencies [20c5fb5]
- Updated dependencies [7fb8eaa]
- Updated dependencies [cffbeea]
- Updated dependencies [1107228]
- Updated dependencies [33e6ab2]
- Updated dependencies [b28788a]
- Updated dependencies [c37a0ba]
- Updated dependencies [c80390f]
- Updated dependencies [f14680e]
- Updated dependencies [2e0e8d4]
- Updated dependencies [d83355b]
- Updated dependencies [f37b70b]
- Updated dependencies [8ca3e54]
- Updated dependencies [1107228]
- Updated dependencies [1107228]
- Updated dependencies [f6172f8]
- Updated dependencies [709b880]
- Updated dependencies [288c2d0]
- Updated dependencies [2913c2f]
- Updated dependencies [afe3a5d]
- Updated dependencies [b22a91f]
- Updated dependencies [781ee0f]
- Updated dependencies [3e638d1]
  - @tom-cat/pi-browser-runtime@0.6.0
