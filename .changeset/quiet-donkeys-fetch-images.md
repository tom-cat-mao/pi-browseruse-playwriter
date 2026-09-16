---
'@tom-cat/pi-browser-runtime': minor
---

Fetch, persist and rewrite page images for `page.extract`.

`page.extract` now takes `images: 'none' | 'urls' | 'save'` (default `none`). `format: 'assets-manifest'` returns the page's image inventory — resolved `src`, `currentSrc`, `srcset`, `alt` and natural size per image, skipping `data:` and unresolved sources — in `value.assets` with an `assetCount` and a model-readable listing, bounded to 200 entries and to the extract preview budget. `images: 'urls'` attaches the same manifest to any other format.

`images: 'save'` reports that same inventory first, then fetches bytes for at most 20 images, each fetched by the page first so the request carries the page's cookies, and falling back to a runtime-side fetch when the page refuses (cross-origin without CORS headers, or the page's own CSP). That fallback only reaches public addresses: a loopback, private, link-local or `localhost` image is reported as a failure instead, so a page cannot make the runtime probe the machine and its own network. Bytes are capped at 16 MiB per image and at 3 MiB per request, the largest payload the 8 MiB worker→relay envelope leaves once the persisted body travels in it. Images beyond the 20-image bound are counted in `value.assetsNotFetched`; one that cannot be fetched, is too large or is a type the artifact store cannot name is reported in `failedAssets` and never fails the rest of the extraction.

The relay writes every saved asset through the artifact store (`label` from the image `alt`, `sourceUrl` from its URL), returns the same artifact descriptors as a screenshot, rewrites the URL of every stored image to its local artifact path — both the `src` attribute and the srcset candidate the browser chose, plus any recorded aliases, on both backends — in the persisted body and in the preview text the model reads, and strips the byte payload before the response leaves the runtime.

Image modes are gated where they are served: a Chrome profile is always allowed because this runtime's own CDP executor fetches the bytes, while a WebExtension profile must advertise the mode in `capabilities.features.assets` and is otherwise refused with `unsupported-capability` before any page traffic leaves the runtime. Chrome profiles now advertise `features: { assets: ['urls', 'save'] }` alongside their supported operations.
