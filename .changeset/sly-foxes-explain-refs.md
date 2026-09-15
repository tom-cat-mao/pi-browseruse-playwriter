---
'@tom-cat/pi-browser-runtime': patch
---

Report a bounded, non-sensitive reason in the Firefox `stale-snapshot` error.

A snapshot ref resolved with the wrong or missing `snapshotId` previously returned only
"missing or stale", so the Firefox acceptance run could not tell which internal lifetime ended
the snapshot. `resolveRef` now appends one fixed enum reason: `missing-snapshot-id`,
`snapshot-replaced`, `ref-not-in-snapshot`, `different-document`, `element-detached`,
`element-document-changed`, `invalidated:<dom-mutation|navigation|explicit-invalidate|action|evaluate|dispose>`,
or `unknown` when the driver cannot attribute it. `snapshot-replaced` is reported only when the requested
`snapshotId` is the exact most recent ended snapshot this driver recorded, which `takeSnapshot` records
when it overwrites an existing snapshot; any other unmatched id stays `unknown`. The driver keeps only
that single most recent ended `snapshotId` plus its enum reason and stores no MutationRecord, DOM node,
text, attribute value, or URL.

The `stale-snapshot` code, the `not-started`/`unknown` outcome, and every rejection condition are
unchanged; refs are still never refreshed, retried, or revived, and no snapshot lifetime,
ownership, permission, CSP, protocol, or timer behavior changes. This is diagnostics only: it does
not fix the still-unreproduced intermittent stale ref.
