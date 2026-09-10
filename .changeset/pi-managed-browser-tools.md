---
'@tom-cat/pi-browser-use-extension': minor
---

Rewrite the Pi browser tools onto the managed runtime HTTP v1 contract. The extension now talks to `@tom-cat/pi-browser-runtime` (default `127.0.0.1:19989`) over the frozen `BrowserRequest`/`BrowserResponse` protocol instead of the legacy playwriter relay on 19988.

- Explicit resource model: `browser_profiles`, `browser_groups` (list/create/rename/close), `browser_tabs` (list/create/close/release) plus tab-scoped `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_evaluate`, `browser_screenshot`, `browser_network`, `browser_logs`, `browser_execute`. No implicit current page; all page ops take an explicit `tabId`.
- Identity is automatic: every request carries the full Pi session UUID from `ctx.sessionManager.getSessionId()` (never an LLM parameter, never a stale module-global). `requestId` is the Pi toolCallId for idempotent creates.
- Structured resources (group/tab ids, `snapshotId`, evaluate values, listings) are serialized into tool content so the LLM can continue; text and inline images are bounded, and runtime responses are validated (protocol v1, managed capabilities, sizes).
- Runtime is launched once on first use via `PI_BROWSER_RUNTIME_PATH` or the packaged `pi-browser-runtime` bin (never npx); a slow/token-protected/foreign or remote listener is never replaced. Configurable via `PI_BROWSER_HOST`/`PI_BROWSER_PORT`/`PI_BROWSER_TOKEN`.
- Cancellation fires a separate best-effort `request.cancel`; aborted mutating requests report `outcome: "unknown"` and are never replayed. `session_shutdown` calls `session.release` only. `/browser-status` is inspect-only. Removed the always-erroring `browser_save_as_pdf`.
