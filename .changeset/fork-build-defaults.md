---
'@tom-cat/pi-browser-runtime': minor
---

Build the fork extension identity by default, in every mode.

`pnpm build` (extension and repo root) builds the fork dev extension: stable ID `eeklahpecooapnailfaebkjjembkjhhg` and managed runtime port `19989`. This also applies to packaged and `PRODUCTION=true` builds, so the bundled extension inside the runtime package always has its own identity and port. A real store listing would need a store key in `extension/vite.config.mts`; there is no store publish flow in this repo.

- Legacy and test flows are explicit opt-ins: `pnpm --filter mcp-extension build:legacy`, `reload:legacy`.
- The package installs only the `pi-browser-runtime` bin. The legacy CLI stays available as `pnpm cli:legacy` and is never installed as a `playwriter` bin, so it cannot shadow an upstream global install.
- `reload:fork` / `reload:legacy` only build and print the `chrome://extensions` URL; they no longer launch Chrome.
- Root `pnpm reload` and `pnpm release` refuse to run (the old flows restarted port `19988` and targeted the upstream store listing).
- The distribution smoke check now verifies the packaged extension carries the fork ID and port `19989`.
