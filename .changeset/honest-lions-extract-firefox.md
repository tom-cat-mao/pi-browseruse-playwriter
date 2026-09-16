---
'@tom-cat/pi-browser-runtime': minor
---

Serve `page.extract` end to end on the Firefox backend.

The Firefox DOM driver can now serialize either the whole document or exactly one strictly matched element for a `page.content` read, and the isolated Firefox worker runs the same Node-side extraction pipeline as Chrome: `markdown`, plain `text` and the windowed `html` format, each bounded to 40,000 characters with `title`, `metadata`, `truncated`, `totalBytes` and the tab `pageInfo`. A selector that is not a single match fails instead of extracting the first element. With `path`, the whole extraction travels back as `value.artifactText` for the relay to write, while the model receives only the bounded preview.

The relay routes `page.extract` to the Firefox executor behind a capability gate: only a profile that advertises `page.extract` in `capabilities.supportedOperations` is asked for it, so an older extension (which reports no list at all) gets a clean `unsupported-capability` and never receives the request. Firefox profiles now advertise their page operations, and a Firefox extraction with `path` is persisted through the artifact store with the same descriptor shape as Chrome.
