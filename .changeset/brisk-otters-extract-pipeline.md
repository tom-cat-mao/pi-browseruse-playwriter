---
'@tom-cat/pi-browser-runtime': minor
---

Add an HTML-to-Markdown extraction pipeline for the managed runtime.

The new `page-extract` module turns page HTML into Markdown or plain text on the Node side: it extracts the main content with Defuddle, keeps data tables as Markdown pipe tables, rewrites relative links against the page URL, and reports title, author, site, published time and excerpt metadata. Callers can filter the result to lines matching a search term with five lines of context, page through it with `offset`/`limit`, and tell from `truncated`/`totalBytes` when they are reading a window instead of the whole extraction.

It is a pure module with no browser or relay dependency, and it is not yet wired into the managed `page.extract` operation; a later change connects it to the relay and the browser backends.
