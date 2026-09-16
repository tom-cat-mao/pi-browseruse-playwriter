---
'@tom-cat/pi-browser-runtime': patch
---

Resolve a relative `page.extract` `path` against the artifacts root instead of the runtime process cwd.

`ArtifactStore` honored only absolute target paths in practice: a relative one such as `foo.md` was resolved against the runtime's working directory, so it always escaped the artifacts root and the write failed with `artifact path escapes the artifacts directory`. A relative path now resolves against the artifacts root — `foo.md` lands at `<artifacts>/foo.md` and `a/b.md` creates `a/` inside it — while an absolute path keeps its meaning and the confinement check is unchanged: a target that climbs out of the root (`../x`, or an absolute path outside it) is still refused before any directory is created.
