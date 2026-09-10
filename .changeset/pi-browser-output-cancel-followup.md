---
'@tom-cat/pi-browser-use-extension': patch
---

Harden the managed browser tools' output bounding and cancellation edges.

- Output budgets are now measured in UTF-8 bytes (not characters), so multibyte content such as thousands of Chinese group names or long URLs is capped at its true size and truncation markers are counted against the budget.
- Large listings (groups/tabs/profiles) are truncated item-by-item into valid, parseable JSON with a `${key}Truncated` count instead of emitting the full giant array or slicing the JSON into an invalid string; `snapshotId` and single group/tab ids are always kept intact.
- `ensureRuntime(signal)` removes its abort listener once the launch race settles, so a caller cancelling during a shared launch no longer leaks a listener on the long-lived signal.
