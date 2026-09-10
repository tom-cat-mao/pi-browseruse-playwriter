---
'@xmorse/playwright-core': patch
'playwriter': patch
---

Fix recorder writing the same click 3 times.

Each Playwright CDP client used to inject its own document click listener. Two sessions, or a leftover enable from a previous recording, turned one user click into two or three `action` events.

The injected recorder is now one instance per document. `enableRecorder()` also attaches its server listener once, even when called concurrently.

```bash
playwriter recorder events -r 66 --type action | jq -r '[.id, .t, .code] | @tsv'
```
