---
'@tom-cat/pi-browser-runtime': patch
---

Allow Firefox frame actions (`frameLocator` fill/click) on stock Firefox, where `Element.getBoxQuads` is not exposed.

Gecko gates `getBoxQuads` behind `nsINode::HasBoxQuadsSupport`, which is `isChrome(cx compartment) || StaticPrefs::layout_css_getBoxQuads_enabled()`, and `layout.css.getBoxQuads.enabled` defaults to false. A WebExtension content script is not chrome, so the member is missing and every frame action was refused with `unsupported-capability`. When `getBoxQuads` is present the previous content-quad validation is unchanged. When it is absent, the ancestor frame content box is now derived from the frame's real client rect plus its used border and padding, and only for a chain that is provably axis-aligned: `transform` must be `none` or an identity matrix, and `rotate`, `scale`, `translate`, `zoom`, `perspective` and `offset-path` must be neutral. Fragmented, degenerate, non-finite, or unreconcilable boxes (including fractional border/padding where the rounded client offset or client box cannot be proven exact) are refused instead of approximated. Ancestor `elementFromPoint` occlusion, viewport bounds, and prepared-action identity checks are unchanged.
