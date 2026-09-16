---
'@tom-cat/pi-browser-runtime': patch
---

Stop a Firefox `tabs.create` from failing without a `tabId` when its optional DOM preheat runs on a tab whose document is not injectable yet.

The native tab and its ownership were already committed before the preheat, so a preheat failure is now logged and the created tab is still returned. The preheat only runs for a `complete` tab whose URL is a supported HTTP(S) page, mirroring the existing `tabs.onUpdated` guard. `tabs.attach` keeps its injection capability probe, and later snapshot/click operations still surface real host-permission or injection errors. No permission, CSP, session, epoch, ledger, atomic-persistence or cancellation semantics change.
