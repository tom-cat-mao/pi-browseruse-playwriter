---
'@tom-cat/pi-browser-runtime': patch
---

Stop the Firefox page console bridge from breaking pages that call `console.log`.

The bridge replaced the page console method with an exported wrapper that forwarded to the page function through `original.apply(pageView.console, args)`. `original.apply` is the page realm's `Function.prototype.apply`, so it read `.length` and the indices of `args`, a rest array created in the extension content-script realm; the page has no access to that sandbox object and threw `Permission denied to access property "length"`, which propagated back into the page's own `console.log` call (the recorder had already stored the line, so the log looked captured). Forwarding now uses the content-script realm's `Reflect.apply(original, pageView.console, args)`, which extracts the arguments in the realm that owns them and still calls the page function with the same `this`. The original console call is not wrapped in a catch, so its errors keep propagating and are not silently hidden, and no object is cloned into the page.
