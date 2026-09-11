# Pi Browser Use

Pi Browser Use lets a Pi agent work with your existing Chrome tabs, logins and
extensions. A local runtime and this Chrome extension communicate over CDP;
the browser stays on your machine.

This repository is a maintained fork of
[remorses/playwriter](https://github.com/remorses/playwriter). It currently has
no npm release and no Chrome Web Store listing.

## Install the Chrome extension

The main download is the versioned ZIP on
[GitHub Releases](https://github.com/tom-cat-mao/pi-browseruse-playwriter/releases).
The first release is still being prepared.

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

## Build from source

Use Node.js and pnpm `10.18.1`:

```bash
pnpm bootstrap
pnpm --filter @tom-cat/pi-browser-runtime build
pnpm package:extension
```

The last command packages the already-built fork extension into
`dist-release/`, producing both the ZIP and its `.sha256` file. It only uses
local bundled JavaScript and assets. The output directory is ignored by Git.

## Install the Pi pieces

The Pi package and the browser runtime are separate from the Chrome ZIP. The
ZIP does not install either one automatically.

```bash
pi install ./pi
node playwriter/bin-runtime.js
```

The Pi package starts its companion runtime when used through Pi; the second
command is the manual runtime path. The runtime uses `19989` by default and
stores its data under `~/.pi-browser-use`.

## Project status

- GitHub Releases: manual Draft release workflow is available for maintainers.
- Chrome Web Store: upload preparation only; no item has been submitted or
  published.
- Store identity: the real Web Store item ID and public key must come from the
  developer dashboard before a store build is made. The fork development ID
  must not be presented as the store ID.

See the [extension distribution checklist](./docs/exec/extension-distribution-plan.md)
for the short maintainer path.

## License and upstream

This fork keeps the upstream [MIT license](./LICENSE) and credits
[remorses/playwriter](https://github.com/remorses/playwriter). The original
README is preserved in Git history.
