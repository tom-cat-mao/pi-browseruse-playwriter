---
'@tom-cat/pi-browser-use-extension': patch
---

Readable browser tool rows, Pi-side discover paging, and a typed-timeout transport grace.

**Human-facing rows.** Folded rows lead with the observed page (title — domain), the action and verifiable counts; opaque ids stay complete in model-visible content and expanded detail, with a short id tail as fallback. Real ANSI/terminal control sequences are stripped before shortening (Unicode/wide-character safe), expanded success detail is byte-bounded instead of dumping raw details, and errors show the complete bounded multiline message with `code`/`outcome` when expanded plus an expand affordance when collapsed. `browser_execute` reports its value and logs, `browser_network stop` reports capture state and retained/dropped counts, history `back` is visible even without a URL, and screenshot images keep rendering through the framework.

**Per-session page context.** Page facts the runtime already returned (a created/attached tab, a listing, or a `pageInfo` observation) are cached per Pi session, bounded and cleared on session shutdown — no extra browser calls and no cross-session titles.

**Discover pagination.** `browser_tabs discover` pages locally with optional `offset`/`limit` (default 20): active tabs first, window focus as tie-break, `total`/`returned`/`nextOffset`/`truncated` reported. `nextOffset` counts the candidates actually returned, so a byte-budget cut never skips an unseen tab, and no new field is sent over the wire.

**Typed-timeout transport grace.** The operation `timeoutMs` (runtime cap 120s) stays distinct from a bounded transport grace, so the runtime can return its typed `timeout` result instead of a raw socket abort. A user abort stays immediate, applies through the whole body read, and cancellation remains a separate request with no automatic replay.
