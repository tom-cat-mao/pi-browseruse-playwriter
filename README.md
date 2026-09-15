# Pi Browser Use

Pi Browser Use lets a Pi agent work with your existing browser tabs and logins.
Chrome uses its debugger/CDP extension; Firefox uses an ordinary WebExtension
with a DOM backend. Both connect to a local runtime, and the browser stays on
your machine. Firefox does not require remote debugging or a special browser
launch, but DOM input and execution have [platform differences](./docs/exec/firefox-extension-guide.md).

This repository is a maintained fork of
[remorses/playwriter](https://github.com/remorses/playwriter). It currently has
no npm release, Chrome Web Store listing, or signed Firefox/AMO release.

## Install the Chrome extension

The main download is the versioned ZIP on
[GitHub Releases](https://github.com/tom-cat-mao/pi-browseruse-playwriter/releases).
Use the versioned extension ZIP, not GitHub's automatically generated source archive.

1. Download `pi-browser-use-extension-<version>.zip` from a Release.
2. Unzip it into a fixed directory that you will keep, such as
   `~/Applications/pi-browser-use-extension`.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load
   unpacked**, and select the unzipped directory containing `manifest.json`.

The ZIP is not a universal one-click Chrome installer: on desktop Chrome,
GitHub manual installation still requires selecting the unpacked directory.
Do not delete or move that directory while the extension is installed. The
Chrome Web Store will provide one-click installation and automatic updates
only after this project passes review; the store listing is **待上架**.

The default development build has extension ID
`eeklahpecooapnailfaebkjjembkjhhg` and connects to the local runtime on port
`19989`.

## Load the Firefox development extension

The Firefox backend targets desktop Firefox 139+ and is pending real-browser
acceptance. Other Firefox-derived browsers need their own compatibility check.
There is no signed Firefox add-on yet; ordinary permanent installation requires
Mozilla signing. The local unsigned ZIP/XPI is a development artifact.

After the source setup below, build and package it with:

```bash
pnpm build:firefox
pnpm package:firefox
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select `extension/dist-firefox/manifest.json`. The temporary add-on is
removed when Firefox restarts. The Pi package and local runtime must also be
installed; they are shared with the Chrome backend.

In Pi, use `browser_profiles` to select the connected Firefox profile, then
`browser_tabs discover` and `browser_tabs attach` to adopt an already-open tab
in place. Loading or attaching does not require refreshing the tab. Firefox
reports its DOM input, DOM/ARIA snapshot, isolated evaluate, and supported
execute capabilities in the profile result.
Dynamic page JavaScript additionally requires Firefox 153+ and the optional
permission enabled in the add-on popup; basic DOM tools work without it.

See the [Firefox guide](./docs/exec/firefox-extension-guide.md) for supported
operations, development settings, and limits imposed by ordinary extensions.

## Build from source

Clone this repository, then use Node.js, Bun and pnpm `10.18.1`:

```bash
pnpm bootstrap
pnpm --filter @tom-cat/pi-browser-runtime build
pnpm package:extension
```

The last command packages the already-built fork extension into
`dist-release/`, producing both the ZIP and its `.sha256` file. It only uses
local bundled JavaScript and assets. The output directory is ignored by Git.
The runtime build also bundles Firefox into `playwriter/dist/extension-firefox`;
`pnpm package:firefox` creates its ZIP, explicitly unsigned XPI, and SHA256 files.
Build and package commands do not install add-ons or open a browser.

## Install the Pi pieces

The Pi package and the browser runtime are separate from the browser ZIPs. A
ZIP does not install either one automatically.

Until npm distribution is available, run these from a source checkout after
completing the build steps above:

```bash
pi install ./pi
node playwriter/bin-runtime.js
```

The Pi package starts its companion runtime when used through Pi; the second
command is the manual runtime path. The runtime uses `19989` by default and
stores its data under `~/.pi-browser-use`.

## Project status

- GitHub Releases: pushing an `extension@<version>` tag automatically builds
  and publishes the extension ZIP and SHA256 file. Manual runs create a Draft.
  The tag version must match `extension/manifest.json`.
- Chrome Web Store: upload preparation only; no item has been submitted or
  published.
- Firefox: ordinary add-on development build, no AMO signing or store
  publication. The Gecko add-on ID is `pi-browser-use@tom-cat-mao.github.io`;
  it is separate from the Chrome extension ID.
- Store identity: the real Web Store item ID and public key must come from the
  developer dashboard before a store build is made. The fork development ID
  must not be presented as the store ID.

See the [extension distribution checklist](./docs/exec/extension-distribution-plan.md)
for the short maintainer path.

## License and upstream

This fork keeps the upstream [MIT license](./LICENSE) and credits
[remorses/playwriter](https://github.com/remorses/playwriter). The original
README is preserved in Git history.
