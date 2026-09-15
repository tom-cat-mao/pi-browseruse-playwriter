# Pi Browser Use browser extensions

The browser extension connects the user's existing tabs and login sessions to
the local Pi Browser Use runtime. It never launches another browser. This is a
maintained fork of [remorses/playwriter](https://github.com/remorses/playwriter),
with the repository's [MIT license and attribution](../LICENSE).

Chrome uses `chrome.debugger` and CDP. Firefox uses an ordinary WebExtension and
DOM operations; it needs no remote-debugging flag. Firefox DOM input cannot
provide trusted native input events, its snapshot comes from DOM/ARIA, and its
evaluate world is isolated from page JavaScript globals. See the
[Firefox capability and loading guide](../docs/exec/firefox-extension-guide.md).

## Build

Complete `pnpm bootstrap` and the initial runtime build at the repository root.
Then build either browser extension without loading it:

```bash
pnpm --filter mcp-extension build
pnpm --filter mcp-extension build:firefox
```

| Browser | Output | Local loading | Identity |
| --- | --- | --- | --- |
| Chrome | `extension/dist` | `chrome://extensions` → Load unpacked | `eeklahpecooapnailfaebkjjembkjhhg` |
| Firefox 139+ | `extension/dist-firefox` | `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json` | `pi-browser-use@tom-cat-mao.github.io` |

The default connection is `127.0.0.1:19989`. Firefox accepts `PI_BROWSER_HOST`
(loopback only) and `PI_BROWSER_PORT` at build time. Its output stays in a
separate directory and cannot overwrite the Chrome bundle. No token is read
from the build environment or compiled into the add-on.

`pnpm build:firefox` at the repository root additionally copies the Firefox
bundle into the runtime package. `pnpm package:firefox` validates that bundle
and creates local unsigned ZIP/XPI files with SHA256 checksums in `dist-release`.
`pnpm package:extension` produces the Chrome ZIP. These commands do not publish.

Neither Chrome Web Store nor Firefox/AMO publication is available. Firefox
temporary loading is for development, expires at browser restart, and does not
replace the signing required for ordinary permanent installation. Do not
disable signing checks as an installation workaround.

## Firefox permissions

| Permission | Use |
| --- | --- |
| `tabs` | Enumerate and manage explicit browser tabs |
| `tabGroups` | Use native Firefox groups for task-created tabs when the API is available |
| `storage` | Persist the installed profile and managed resource ownership |
| `webNavigation` | Track document navigation and tab lifecycle |
| `scripting` | Run the bundled DOM driver in an explicitly controlled tab |
| `webRequest`, `webRequestBlocking`, `webRequestFilterResponse` | Capture requests and bounded response text for explicitly controlled tabs |
| `<all_urls>` | Inject the DOM driver into ordinary user-selected pages and capture their content |
| Optional `userScripts` | Firefox 153+ can run dynamic page JavaScript in an isolated user-script world after the user enables it in the popup |

Firefox refuses extension access to browser-internal and other protected pages.
The add-on reports unsupported operations instead of requesting debugger or
remote-agent access. Existing-tab discovery reads metadata; attach preserves
the tab's window, form values, and scrolling.
