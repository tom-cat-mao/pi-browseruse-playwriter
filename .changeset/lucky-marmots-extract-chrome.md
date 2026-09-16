---
'@tom-cat/pi-browser-runtime': minor
---

Serve `page.extract` end to end on the Chrome backend.

The managed executor now implements `page.extract` for Chrome profiles: it reads the page HTML (or the strict `selector` match) with a read-only CDP call and runs the Node-side extraction pipeline, returning `markdown`, plain `text` or the serialized `html` with `title`, `metadata`, `truncated` and `totalBytes`. Results are bounded to 40,000 characters like `page.snapshot`, so a single over-long page cannot flood the model, and the `text` format no longer leaks Markdown syntax from the assembled title, metadata line or excerpt. `format: 'assets-manifest'` still reports `unsupported-capability` (a later wave adds it).

The relay validates and routes `page.extract`, writes the full extraction through the artifact store when the caller passes `path` (Markdown as `.md`, HTML as `.html`, still confined to the runtime artifacts directory), and returns an artifact descriptor while the model keeps only the bounded preview. Chrome profiles now advertise `page.extract` in `capabilities.supportedOperations`.
