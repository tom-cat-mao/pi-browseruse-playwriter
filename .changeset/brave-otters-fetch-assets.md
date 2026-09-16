---
'@tom-cat/pi-browser-runtime': minor
---

Serve `page.extract` image assets on the Firefox backend through an extension byte channel.

`format: 'assets-manifest'` now enumerates the page's images instead of reporting `unsupported-capability`: the worker reads them with the existing DOM `evaluate` command (the page-side path `page.evaluate` uses, so `currentSrc`, `srcset`, `alt` and natural dimensions are what the page actually shows), keeps up to 200 images per manifest, skips inline `data:` and empty sources, and returns them as `value.assets` with a one-line-per-image preview. `images: 'urls'` attaches the same manifest to a `markdown`/`text`/`html` extraction without moving any bytes.

`images: 'save'` fetches bytes where a browser-only fetch is possible: the extension background loads each image with the browser's cookies and its `<all_urls>` host permissions (no CORS, no page-context workaround), and answers base64 with the served `mimeType`. The channel is bounded — 20 images per extraction, 16 MiB per image, 64 MiB in total — and isolated per image: a 404, a non-image content type, an oversized body or a page-local `blob:` source lands in `value.failedAssets` with a reason while its siblings still save. Images that the 20-image bound leaves untried are counted in `value.assetsNotFetched`. The worker reports `value.savedAssets` (`base64`, `mimeType`, `alt`, `src`) for the relay to persist; when the runtime cannot carry the channel, every image is reported as a failed image rather than failing the extraction.

Firefox profiles now advertise `capabilities.features.assets: ['urls', 'save']`, so a runtime that gates image modes refuses them for an extension that predates the channel instead of sending a request it cannot answer. Asset payloads travel in their own IPC frame budget derived from the byte limits above; every other Firefox message keeps the 8 MiB limit.
