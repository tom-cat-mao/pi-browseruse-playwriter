---
"@tom-cat/pi-browser-use-extension": minor
---

Add `browser_fill_form`: fill many fields of one form in a single deterministic call, with no model in the loop.

The batch resolves every strict selector before it types anything, through the same single-match path `browser_fill` uses (CSS, or `text=` / `role=` / `internal:label=` on that tab's backend). A selector that matches zero or several elements is a failure: nothing is filled, and every failing selector is reported by name with the runtime's own error. When resolution passes, the tool issues one `page.fill` per field, in order, and reports each field as `filled`, `failed`, or `not-attempted` — the first failed fill stops the batch, and an `outcome=unknown` on it is carried into the model-visible result instead of being swallowed.

Snapshot refs (`aria-ref=eN`, `@eN`) are refused up front with an explanation: every fill invalidates the latest snapshot, so a ref from one `snapshotId` would be dead for every field after the first. Batches are bounded to 30 fields, and a refused batch leaves the page untouched — the resolution probe is a read that never replaces the tab's latest snapshot.
