---
'@tom-cat/pi-browser-runtime': patch
---

Fix the Firefox `browser_snapshot` and role-locator failure `'getComputedStyle' called on an object that does not implement interface Window`.

`ariaVisible` passed no computed-style implementation to `isInaccessible`, so dom-accessibility-api extracted `element.ownerDocument.defaultView.getComputedStyle` and called it as a bare function. Firefox's WebIDL method rejects an undefined `this`; JSDOM does not catch it because its `getComputedStyle` ignores `this`, and the Chrome backend does not use this DOM driver. The call now supplies a helper that reads the view from the element's own document and invokes `view.getComputedStyle(element)` as a method, so the subtree path uses the same implementation and each same-origin iframe document resolves its own view. `computeAccessibleName` keeps its existing bound call, hidden-node filtering is unchanged, and no permission, CSP, protocol, ownership or cancellation semantics change.
