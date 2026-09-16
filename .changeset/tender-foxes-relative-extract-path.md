---
"@tom-cat/pi-browser-use-extension": patch
---

The `page.extract` tool description now documents that `path` may also be relative to the runtime's artifacts directory, matching the runtime's behavior.

The image manifest listing now falls back to an image's `currentSrc` when it has no `src` attribute (srcset-only images), so those images appear in the listing instead of being silently dropped.
