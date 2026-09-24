---
"@tom-cat/pi-browser-use-extension": minor
---

Slim the model-resident browser prompt text by about a third: the `browser_*` tool descriptions and `promptGuidelines` now carry only each tool's own semantics and the cross-tool orchestration, while the backend detail they used to state — extraction assets and the capability gate, tab discover/attach/release semantics, Firefox evaluate/execute behavior — moves to the on-demand `browser-use` skill (index in `skills/SKILL.md`, topic files `extract.md`, `firefox.md`, `tabs.md`). Tool behavior, parameters and runtime calls are unchanged.

The same slimming now extends to tool visibility: the 13 `browser_*` tools are dormant by default and do not reach the model until it calls the always-resident, parameter-less `browser` gateway tool, which activates the whole fleet. Expect the first browser task after upgrading to open with that activation call. Set `PI_BROWSER_TOOLS=always` to keep every tool resident as before.
