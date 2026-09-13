---
'@tom-cat/pi-browser-runtime': patch
---

Report a bounded, non-sensitive reason in the Firefox `stale-snapshot` error.

A snapshot ref resolved with the wrong or missing `snapshotId` previously returned only
"missing or stale", so the Firefox acceptance run could not tell which internal lifetime ended
the snapshot. `resolveRef` now appends one fixed enum reason: `missing-snapshot-id`,
`snapshot-replaced`, `ref-not-in-snapshot`, `different-document`, `element-detached`,
`element-document-changed`, `invalidated:<dom-mutation|navigation|explicit-invalidate|action|evaluate|dispose>`,
or `unknown` when the driver cannot attribute it. The driver keeps only the most recent
invalidated `snapshotId` plus its enum reason and stores no MutationRecord, DOM node, text,
attribute value, or URL.

The `stale-snapshot` code, the `not-started`/`unknown` outcome, and every rejection condition are
unchanged; refs are still never refreshed, retried, or revived, and no snapshot lifetime,
ownership, permission, CSP, protocol, or timer behavior changes. This is diagnostics only: it does
not fix the still-unreproduced intermittent stale ref.
