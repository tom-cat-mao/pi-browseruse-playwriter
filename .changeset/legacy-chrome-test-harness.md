---
'@tom-cat/pi-browser-runtime': patch
---

Build the legacy extension identity in the Chrome test harness.

`playwriter/src/test-utils.ts` now runs `pnpm build:legacy` in `extension/`
instead of the fork default `pnpm build`. The legacy browser regression suites
assert the upstream dev extension ID, so the harness keeps that identity while
`pnpm build` stays the fork build for users. The test port and dist env vars
are unchanged, and the new Chrome acceptance harness builds the fork extension
through its own `build:fork` path, so it is unaffected.
