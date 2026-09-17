---
"@tom-cat/pi-browser-use-extension": patch
---

Deduplicate the model-resident browser guidance: the tool `promptGuidelines` now carry only cross-tool orchestration (resource chain, discover/attach, refs and snapshot invalidation, observe → act → observe, release/close, cancellation outcomes) while each tool's own semantics live in its description, and the `browser-use` skill is registered with frontmatter and slimmed to on-demand backend detail such as Firefox execute waits and snapshot refs.
