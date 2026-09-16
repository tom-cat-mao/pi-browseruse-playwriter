---
'@tom-cat/pi-browser-runtime': patch
---

Report every URL the page used for an image on the Firefox `page.extract` image channel, so the relay's URL rewrite binds the `src` attribute too.

A Firefox `images: 'save'` run now enumerates an image's `src` attribute and the srcset candidate the browser chose as separate fields, the way the Chrome backend reads them, and a saved asset carries `sourceUrls` — both spellings, deduplicated and only attached when they differ — next to the URL whose bytes were fetched. The relay rewrites every one of them to the artifact path in the persisted body and in the preview, so a Markdown body that kept the `src` attribute of an image whose bytes came from its srcset candidate no longer points at the remote URL. This closes the rewrite gap the Chrome backend had already closed.

The Firefox manifest (`value.assets`) reports those same two URLs, so an image whose `src` attribute and chosen candidate differ now reports both there as well, and a srcset-only image with no `src` attribute is listed instead of dropped.
