---
'@tom-cat/pi-browser-use-extension': minor
---

Expose the image asset modes of `page.extract` in `browser_extract`.

`browser_extract` now takes `images` (`none` — the default, `urls`, `save`) and
the `assets-manifest` format. `urls` and `assets-manifest` return the page's
image manifest (`src`, `alt`, `naturalWidth`, `naturalHeight` — the intrinsic
pixel size the runtime reports) without fetching any bytes: the model-visible
result reports the count, the first few images with their pixel size, and the
counters that qualify the listing — `assetsTruncated`/`assetCount` when the page
has more images than the manifest carries, and `assetsNotFetched` when a `save`
run left images over the per-request fetch limit — while the full listing rides
in the structured value. `save` downloads the images through the
runtime, where each saved file comes back as an artifact (`path`, `mimeType`,
`bytes`, and `label` = the image's alt text), the Markdown image URLs that were
saved are rewritten to those local paths, and images that could not be fetched
are reported in `failedAssets` (`src` plus the reason) with a warning that those
keep their remote URLs. Artifact descriptors in model content are now bounded and
carry the label, so a save run with many images cannot flood the context.

The pre-flight gate now checks one level deeper than `page.extract`: an `images`
mode other than `none` is refused with a model-facing reason — naming the profile
and the asset modes it does advertise — when the target webextension profile does
not advertise that mode in `features.assets`, so nothing is downloaded for a mode
that browser build cannot serve. Chrome profiles, served by the runtime, and a
peer that advertises no capabilities at all are left to the runtime's own
`unsupported-capability` answer, matching the existing layering for
`supportedOperations`. `browser_profiles` now projects the `assets` feature key
alongside `extract` into model content.
