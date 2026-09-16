---
'@tom-cat/pi-browser-runtime': patch
---

Harden the `page.extract` image channel on both backends.

The runtime-side fallback fetch for a Chrome image refuses loopback, private and link-local targets — including short, decimal and hexadecimal IPv4 spellings and `localhost` — instead of fetching them on the page's behalf; such an image is reported in `failedAssets` with the reason.

Image byte budgets are now stated where they bind: a Chrome request carries at most 3 MiB of image bytes (4 MiB of base64) because the saved images share the 8 MiB worker→relay envelope with the persisted body, and the message for an image that does not fit says so instead of blaming the number of images. The Firefox manifest is bounded to the same 40,000 bytes and field lengths as the Chrome one, so a page with huge `srcset` values cannot fail its own extraction, and a Firefox worker now has the heap a full 64 MiB batch needs (such a batch arrives in one ~85 MiB base64 frame) instead of dying with the whole extraction as `outcome-unknown`.

A saved image now reports every URL the page used for it, and the relay rewrites all of them to the artifact path, so a Markdown body that kept the `src` attribute of an image whose bytes came from its srcset candidate no longer points at the remote URL.
