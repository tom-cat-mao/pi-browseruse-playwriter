# browser_extract — content, exports, and image assets

Read me when you call `browser_extract` to read or export a page: formats and windowing, `path`
exports, the three `images` modes, and the capability gate that can refuse the call before it runs.

## What it is, and what it is not

- Formats: `markdown` (default), plain `text`, the raw `html`, or `assets-manifest` — the page's
  image listing instead of text.
- It returns no element refs and no snapshotId and is not a structure operation: use
  `browser_snapshot` (or a strict selector on the acting tool) when you need to click/fill,
  `browser_extract` when you need the content.
- It reads without touching the page, so it does not invalidate the latest snapshot.

## Bounded output and windowing

- Every result reports `truncated`/`totalBytes`: a truncated result is a window of the document,
  never the whole extraction.
- `search` keeps only the lines matching a term, with surrounding context.
- `offset`/`limit` page through the extracted lines.

## `path` exports

- Passing `path` makes the runtime write the full extraction there and return an artifact descriptor
  (`path`/`mimeType`/`bytes`); the tool result still keeps only the bounded preview.
- The path is confined to the runtime's artifacts directory: absolute paths inside it are used as-is,
  relative paths resolve inside it, anything escaping it is refused. Never invent an export path
  outside it.

## `images` modes

- `none` (default): remote image URLs are left as they are.
- `urls`: adds a manifest with `src`/`alt`/`naturalWidth`/`naturalHeight` per image and downloads
  nothing. The manifest answers "which images does this page use" on its own.
- `save`: downloads the images through the runtime, reports each saved image as an artifact
  (`path`/`mimeType`/`bytes`/`label=alt`), and rewrites markdown image URLs to those local artifact
  paths. Read the artifact list before claiming an image was saved, and never invent a local path.

## Partial results — do not over-claim

- `assetsTruncated`/`assetCount`: the manifest was cut short — never present a partial listing as the
  complete one.
- `assetsNotFetched`: images over the per-request save limit — neither saved nor failed.
- `failedAssets`: each entry carries its `src` and a `reason`; those were NOT saved and keep their
  original remote URL in the text.

## Capability gate (runs before execution)

- The tab's profile must advertise `page.extract` (see `browser_profiles`); a webextension (Firefox)
  profile must also advertise the asset mode being asked for.
- The gate is a precheck: an unsupported combination is refused before anything is downloaded or
  changed. The fix is to update that browser's extension, or fall back to `images="none"` and read
  there with `browser_snapshot`/`browser_evaluate`.
- Absence is not a claim of "unsupported": a profile with no capability list at all predates the
  negotiation and is left to the runtime, as is Chrome, which the runtime serves by synthesizing its
  feature set. An unknown tabId is also left to the extract request so the real resource error
  surfaces.

## Read the result first

- The tool's result row already inlines these fields (format, size, `truncated`, image counts,
  failed/artifact lines) — read it before judging what came back.
