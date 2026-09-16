---
'@tom-cat/pi-browser-runtime': patch
---

Route browser bytes through a first-class artifact store and forward the optional capabilities feature matrix.

- Add `artifact-store.ts`: writes payloads under `<dataDir>/artifacts`, names files from a sanitized label plus a timestamp/random suffix, maps mime types to png/jpg/webp/gif/svg extensions (unknown mime types are rejected), enforces a per-file and per-session byte budget, and confines every write to the artifacts root with a realpath check.
- Firefox screenshots now go through that store: an explicit absolute `path` is still written exactly where the caller asked, while a screenshot without a path is persisted under `<dataDir>/artifacts` and reported as an artifact descriptor with `bytes` and `label`. PNG validation for screenshots is unchanged.
- `capabilities.features` (`Record<string, readonly string[]>` from newer extensions) is validated by shape and passed through instead of being rejected as an unexpected field; unknown feature names remain ignored.
