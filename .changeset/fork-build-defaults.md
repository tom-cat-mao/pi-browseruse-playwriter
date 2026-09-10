---
'@tom-cat/pi-browser-runtime': minor
---

Build the fork extension identity by default.

`pnpm build` (extension and repo root) now builds the fork dev extension with stable ID `eeklahpecooapnailfaebkjjembkjhhg` and managed runtime port `19989`, so a normal build can no longer hand out the upstream dev ID or point at the legacy relay. Legacy and test flows are explicit opt-ins: `pnpm --filter mcp-extension build:legacy`, `reload:legacy`, `release:legacy`.

The ambiguous root `pnpm reload` and `pnpm release` now refuse to run: the old flows restarted port `19988` and targeted the upstream Chrome Web Store listing. Use `reload:fork` for the fork, or `reload:legacy` / `release:legacy` when you explicitly want the upstream flow. `PRODUCTION=true` store builds keep the legacy port and omit the dev key.
