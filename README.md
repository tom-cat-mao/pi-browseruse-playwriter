# Pi Browser Use

English | [简体中文](./README.zh-CN.md)

Pi Browser Use lets a Pi agent work with your real browser — the tabs, cookies
and logins you already have — through the `browser_*` tools. Chrome is driven by
a `chrome.debugger` extension; Firefox 139+ and Zen use an ordinary WebExtension
with a DOM backend, with no remote debugging or special launch. Both talk to a
managed runtime on `127.0.0.1:19989` (data in `~/.pi-browser-use`), and the
browser never leaves your machine — there is no cloud browser.

Downloads are the versioned artifacts on
[GitHub Releases](https://github.com/tom-cat-mao/pi-browseruse-playwriter/releases);
a release is published automatically when an `extension@<version>` tag is
pushed. Use those artifacts, not GitHub's auto-generated source archive.

## Install the Chrome extension

Chrome is not on the Web Store yet (listing planned), so this is a one-time
manual load:

1. Download `pi-browser-use-extension-<version>.zip` from a Release.
2. Unzip it into a permanent directory you will keep, for example
   `~/Applications/pi-browser-use-extension`. Do not move or delete it while the
   extension is installed.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked** and select the folder containing `manifest.json`.

The development build has extension ID `eeklahpecooapnailfaebkjjembkjhhg`, and
its options page ships a local getting-started guide.

## Install the Firefox / Zen add-on

Firefox 139+ and Zen install the Mozilla-signed
`pi-browser-use-firefox-extension-<version>.xpi`, which comes from the AMO
unlisted (self-distributed) channel and installs permanently:

1. Download `pi-browser-use-firefox-extension-<version>.xpi` from a Release.
2. Open `about:addons`, click the gear icon, choose **Install Add-on From
   File…** and select the XPI.

The `-unsigned.xpi` and the Firefox ZIP are development artifacts: load them
temporarily through `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on**; they disappear when Firefox restarts. Dynamic page JavaScript needs
Firefox 153+ and the optional permission in the add-on popup — the DOM tools
work without it. See the [Firefox guide](./docs/exec/firefox-extension-guide.md).

## Install the Pi side

The browser download does not install the Pi package or the runtime. From a
source checkout (Node >= 20, pnpm `10.18.1`, Bun):

```bash
pnpm bootstrap
pnpm --filter @tom-cat/pi-browser-runtime build
pi install ./pi
```

There is no npm release yet, so the Pi package is installed from this checkout.
The runtime is not a service you manage: Pi starts it on first tool use, and
`/browser-status` reports reachability, capabilities and connected profiles.

## What it can do

- Drive a real tab by explicit `tabId`: accessibility snapshot, click, fill,
  evaluate, screenshot, console logs, network capture.
- Adopt a tab the user already has open with `browser_tabs discover` + `attach`,
  in place: no reload, no window move, scroll and form state preserved;
  `release` hands it back when you are done.
- `browser_extract` exports a page as Markdown, text or HTML, saves the full
  extraction into the runtime's artifacts directory, and can download the page's
  images there too.
- Isolate parallel work across several browser profiles and named groups per
  session; each group is bound to one profile.

## Documentation

| Document                                                                       | Contents                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| [Firefox guide](./docs/exec/firefox-extension-guide.md)                        | DOM backend capabilities, limits and Chrome differences |
| [Extension distribution checklist](./docs/exec/extension-distribution-plan.md) | Release assets, AMO signing and Web Store preparation   |
| [Model-side usage](./pi/skills/SKILL.md)                                       | How the agent is expected to drive the tools            |
| [AGENTS.md](./AGENTS.md)                                                       | Repository layout, commands and contribution rules      |
| [README.zh-CN.md](./README.zh-CN.md)                                           | Simplified Chinese mirror of this page                  |

## License and upstream

Pi Browser Use is a maintained fork of
[remorses/playwriter](https://github.com/remorses/playwriter), keeping the
upstream [MIT license](./LICENSE) and attribution.
