---
"@tom-cat/pi-browser-use-extension": patch
---

Slim the model-resident browser prompt text by about a third: the `browser_*` tool descriptions and `promptGuidelines` now carry only each tool's own semantics and the cross-tool orchestration, while the backend detail they used to state — extraction assets and the capability gate, tab discover/attach/release semantics, Firefox evaluate/execute behavior — moves to the on-demand `browser-use` skill (index in `skills/SKILL.md`, topic files `extract.md`, `firefox.md`, `tabs.md`). Tool behavior, parameters and runtime calls are unchanged.
