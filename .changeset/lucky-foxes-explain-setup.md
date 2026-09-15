---
'@tom-cat/pi-browser-runtime': patch
---

Add a local, offline Chinese getting-started page to both browser builds.

Chrome opens `src/tutorial.html` from `manifest.json` `options_ui` (extension
options, or the icon context menu); Firefox 139+ opens `firefox-tutorial.html`
from `manifest.firefox.json` `options_ui` (add-on options) plus a Help link in
the add-on popup. Both pages are bundled HTML/CSS/JS with no remote assets, no
new permission, and no CSP exception, and they never connect to the runtime,
adopt or open a tab, or start the runtime. Their content documents the current
Pi Browser Use flow (source install, paired managed runtime, `browser_profiles`
→ `browser_tabs discover`/`attach` → `browser_snapshot` → `browser_tabs
release`) instead of the old `npx playwriter` commands.

No new automatic opening path was added. Chrome keeps its pre-existing
development paths, which changed only in which page they show: the idle-icon
click already opened `src/tutorial.html`, and the install-time open now calls the
same helper because the obsolete `welcome.html` is removed. Packaged builds still
compile that install-time open out (`PLAYWRITER_OPEN_WELCOME_PAGE=0`).

Packaging also verifies every manifest-declared local entry point (`background`,
`default_popup`, `options_ui.page`, `options_page`, icons) and each page's local
`<script src>` / `<link href>` / `<img src>` / `<a href>` before writing a
ZIP/XPI, so a missing page or asset fails the build instead of shipping. A
manifest entry must be a non-empty local path that exists in the bundle: a
remote URL, an empty string, a path that escapes the package, or a non-string
value now fails the package instead of being skipped. Explicit external links in
pages (`https:`, `mailto:`, `#fragment`) stay allowed.

With `welcome.html` gone, Prism has no consumer left: its CDN download script,
the build step that ran it, and the Prism-only packaging assertion are removed,
so building the extension no longer depends on a network download. Extension
builds now clear their own output directory first, so a removed page or asset
cannot survive in a loadable build or in a release archive. The Chrome output
directory must be `dist` or `dist-<suffix>`: source directories, parent or
nested paths, and the Firefox output directory are rejected before anything is
deleted, and a symlinked output directory only loses the link, never the
directory it points at.
