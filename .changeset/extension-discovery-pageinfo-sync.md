---
'@tom-cat/pi-browser-runtime': patch
---

sync discovered tab ordering and page metadata in the extension

- `tabs.discover` now lists the active tab of every window first, with the focused window only ordering ties. The bug report had the active page at the end of 145 candidates, beyond the model-visible budget; the stable window/index tie-break keeps the listing deterministic for pagination.
- `chrome.tabs.onUpdated` url/title updates are merged into the authoritative managed inventory and published as one coalesced `browserInventory` message per burst, so `tabs.list` stops returning stale url/title. The coalescing interval is fixed (later updates join it instead of moving the deadline), so continuous title changes cannot starve the publish, and no disk write is added per title change.
- coalesced publishes are fenced by the connection generation: a disconnect/reconnect drops the pending snapshot instead of racing the restore that publishes freshly observed Chrome state. Released tombstones and browser epochs are respected, and the refresh only touches display metadata - owner, group/session binding and debugger attachment stay unchanged.
