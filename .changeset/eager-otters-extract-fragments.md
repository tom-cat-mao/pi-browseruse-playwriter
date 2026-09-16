---
'@tom-cat/pi-browser-runtime': patch
---

Keep the body of a selector-scoped `page.extract` instead of reporting it as an empty document.

A `selector` returns one element's `outerHTML`, so the extraction pipeline received a bare `<div>`/`<section>` rather than a document. Defuddle then scored the fragment on its own class and id, and a container whose name carries no article keyword scored as boilerplate: a 2.4k character body came back as 0 characters with `ok` and `truncated: false`, so the model saw a successful extraction with no content and no way to tell why. Inputs without an `<html>` or `<body>` tag are now wrapped in a minimal document before extraction — carrying the title the caller passes, when it has one — which also gives the sparse-content retry a `<body>` to fall back to.

Extraction now also fails explicitly instead of losing content silently: when a document with 4,000 or more visible characters extracts to 200 characters or fewer, `page.extract` fails with `execution-failed` and a message naming both counts, rather than returning near-empty text that looks complete.
