---
'@tom-cat/pi-browser-runtime': patch
---

Make managed snapshots and page actions fail fast and report truthfully.

- **Bounded snapshot scope selectors.** A `locator` scope that matches no elements or more than one now returns a clear, short error before the AX scan. Scope marking uses the remaining request budget, missing markers fail instead of falling back to the whole page, and UUID-guarded cleanup is best-effort with a 100ms native timeout.
- **Refs match model-visible snapshot text.** Search context, offset/limit, line count, UTF-8 byte/character truncation, and structured-ref budgets are applied together. Only refs whose complete lines and metadata fit are returned, while no-match searches return no refs.
- **Native `<details>`/`<summary>` get a valid selector.** Chrome exposes these as the unsupported `disclosuretriangle` AX role. Normal document and open-shadow summaries now use exact DOM ancestry and `:nth-of-type()` selectors that count hidden siblings; summaries in documents that `page.locator` cannot safely address are shown without an actionable ref.
- **Clearer stale-ref explanations.** Snapshot-ref errors now say whether no snapshot is current (a prior navigate/click/fill/evaluate/execute invalidated it), the snapshot was replaced, or the ref was filtered out by the search/offset/limit window — and how to recover.
- **Click reports an observation, not a settled navigation.** The click result URL is the tab state observed immediately after the click, never a promise that a triggered navigation has finished; no sleeps or auto-goto.
- **`full` snapshot flag is coherent.** `full: true` forces the complete readable tree (labels, contexts, text) even when a caller would narrow to interactive-only, and stays subject to the same line/character caps and windowing.
- **Request-aware native timeouts.** Navigate, back, click, fill, and snapshot-scope resolution use the request budget remaining after page lookup, capped at 30s for navigation and 5s for selectors with response time reserved. Outer worker cancellation still terminates unresponsive CDP/evaluate work and actions are never replayed.
- **Observed page context on results.** Page operations attach a `pageInfo { tabId, url, title? }` from cached URL and titles actually computed by navigate/back. Arbitrary evaluate/execute objects with a `title` business field no longer fabricate a page title.
