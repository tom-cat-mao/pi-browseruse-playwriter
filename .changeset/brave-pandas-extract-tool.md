---
'@tom-cat/pi-browser-use-extension': minor
---

Add the `browser_extract` tool for reading and exporting page content.

`browser_extract` reads a managed tab's content instead of its structure: `markdown` (the default), plain `text`, or the raw `html`. It returns no element refs and no `snapshotId` and performs no page action, so a snapshot taken before it stays valid — use `browser_snapshot` when you need to act on the page. Output is bounded and windowed: the result reports `truncated`/`totalBytes`, states in words when the text is a window of the document, keeps only the lines matching a `search` term (with surrounding context), and pages through the extraction with `offset`/`limit`. Passing an absolute path inside the runtime's artifacts directory saves the full extraction through the runtime and returns an artifact descriptor (`path`/`mimeType`/`bytes`) while the model keeps only the bounded preview.

The tool is gated on the target tab's profile before anything is sent: a profile that advertises its page operations without `page.extract` is refused with a model-facing reason instead of an empty extraction, while a peer that advertises no operation list at all is not blocked. `page.extract` is now a known operation for capability gating, and `browser_profiles` projects the relevant `capabilities.features` keys (currently `extract`) into model content so the model can see which extraction formats a profile supports; unrelated or unknown feature keys stay out of the model's context.
