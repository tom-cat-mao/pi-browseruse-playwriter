---
'@tom-cat/pi-browser-runtime': patch
---

Keep the real image URL in a MediaWiki `page.extract` instead of the file description page.

Parsoid markup puts `resource="…/wiki/File:X.jpg"` on every article image: an RDFa pointer at the file description page, not at the image bytes. Defuddle's generic lazy-load transform scans each image attribute for a value that looks more like the real image URL and prefers an absolute one, so the Markdown carried `![](https://…/wiki/File:X.jpg)` while the bytes URL survived only in `srcset` — whose `2x` density descriptors the same transform's image selection skips. On a real Wikipedia article that left the URL-to-artifact rewrite matching 1 image out of 12. The attribute is now removed from the document handed to both extraction passes, so an image keeps the URL its `src`/`srcset` actually serves. `format: 'html'` still returns the page exactly as it was serialized, `resource` included.
