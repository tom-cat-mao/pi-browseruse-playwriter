---
title: Pi Browser Use
description: Source-built Pi tools plus a forked Playwriter runtime and Chrome extension that drive your own browser.
prompt: |
  用户要求把根 README 从上游 WebStore/npm 安装入口改成 Pi Browser Use 产品
  README（约 1-2 屏），且不得假称已发布。需覆盖：
  - 同仓库自维护 runtime @tom-cat/pi-browser-runtime（源码在 playwriter/，
    见 @playwriter/package.json），只安装 pi-browser-runtime 一个 bin；
    Pi 包 @tom-cat/pi-browser-use-extension（见 @pi/package.json）。
  - 无 npm / Chrome Web Store 发布入口，用户从源码构建并 load unpacked。
  - 构建：pnpm 10.18.1（@package.json 的 packageManager）、pnpm bootstrap、
    pnpm build；fork 扩展 ID eeklahpecooapnailfaebkjjembkjhhg、默认端口
    19989（见 @extension/vite.config.mts @extension/package.json
    @extension/manifest.json）。安装 Pi 包用 pi install ./pi 或绝对路径。
  - managed 语义：一个 Pi session 多个命名分组、显式 groupId/tabId、
    每分组绑定一个 profile；断线不散组、用户释放不拉回、完整 Chrome 重启
    无法核验时标 needs-rebind；只提供工具，不含 agent/HITL/业务工作流。
    契约见 @docs/exec/browser-runtime-contract.md @playwriter/src/browser-protocol.ts。
  - 如实说明最终独立 review 当前 FAIL（C outcome/lease 修复中）、Chrome
    验收未开始，链接 @docs/exec/browser-rebuild-progress.md；不写短期测试数字。
  - 保留上游版权/来源链接与 LICENSE，不带广告/云账单长文；旧 README 用
    Git 提交链接保留。参考 @docs/exec/browser-rebuild-plan.md
    @playwriter/src/skill.md @pi/README.md。
---

# Pi Browser Use

Pi Browser Use drives **your own Chrome** — your logins, extensions and tabs —
from a Pi agent session. A local runtime talks to a Chrome extension over CDP,
so automation runs in the browser you already use instead of a fresh one.

This repository is a **fork of [remorses/playwriter](https://github.com/remorses/playwriter)**
that keeps the upstream WebSocket/CDP protocol and adds a managed runtime,
explicit sessions/groups/tabs and a Pi package. It is source-only: there is
**no npm release and no Chrome Web Store listing** for this fork. Installing
`playwriter` from npm or from the store installs upstream, not this project.

## Pieces

| Piece | Where | Package / identity |
| --- | --- | --- |
| Managed runtime (relay) | `playwriter/` | `@tom-cat/pi-browser-runtime`, only bin is `pi-browser-runtime` |
| Pi package (tools + skill) | `pi/` | `@tom-cat/pi-browser-use-extension` |
| Chrome extension | `extension/` | fork dev ID `eeklahpecooapnailfaebkjjembkjhhg` |

## Build from source

```bash
# once per clone: playwright submodule, deps, generated sources
pnpm bootstrap        # pnpm 10.18.1 is pinned by packageManager

# runtime package + fork extension
pnpm build            # requires bun for the runtime build scripts
```

Load the extension in Chrome:

1. `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** ->
   select `extension/dist`.
2. The default build always embeds the **fork** identity
   `eeklahpecooapnailfaebkjjembkjhhg` and targets runtime port `19989`
   (see `extension/vite.config.mts`).
3. Click the extension icon on a tab to connect it.

Start the runtime (the Pi package starts its companion runtime itself, this is
the manual path):

```bash
node playwriter/bin-runtime.js
# 127.0.0.1:19989, data and logs in ~/.pi-browser-use
```

Configuration is read from the environment: `PI_BROWSER_HOST` (`127.0.0.1`),
`PI_BROWSER_PORT` (`19989`), `PI_BROWSER_TOKEN` (optional, required for
non-loopback binds), `PI_BROWSER_DATA_DIR` (`~/.pi-browser-use`). The managed
runtime never starts, stops or replaces the legacy upstream relay on `19988`.

Install the Pi package from a checkout:

```bash
pi install ./pi
# or an absolute path to the same folder
pi install /path/to/checkout/pi
```

The package registers the managed browser tools and talks HTTP to the runtime;
it does not spawn a browser or call `npx playwriter@latest`.

## Managed model

- One Pi session can own **multiple named groups**. Every group has exactly one
  owner session, one required name and one bound profile.
- Groups and tabs are addressed by explicit `groupId` / `tabId` — opaque
  logical IDs, never Chrome's numeric IDs and never guessed from URL or group
  title. Reusing a group means passing its `groupId`.
- The extension registry in `chrome.storage` is the source of truth for
  ownership. The runtime checks session ownership and never re-derives it.
- Relay/WS disconnects, extension reloads and Pi exits **keep** groups and
  ownership. A tab the user dragged out or released is recorded as released
  and is **not pulled back** on reconnect.
- After a full Chrome restart ownership cannot always be verified; those
  resources are marked `needs-rebind` instead of being reattached by URL or
  title.
- These are **tools only**: no agent loop, no captcha or business checks, no
  HITL confirmation buttons, no automatic replay of page actions. Pi is the
  agent and decides what to do.

## Status

The final independent review is currently **FAIL**: the C executor's
outcome/lease fixes are in progress and the user-assisted Chrome acceptance has
not started. Current, evidence-based state is tracked in
[docs/exec/browser-rebuild-progress.md](./docs/exec/browser-rebuild-progress.md);
this README intentionally does not freeze temporary test numbers. Chrome
acceptance is a separate, user-authorized phase.

## Docs

- [Rebuild plan](./docs/exec/browser-rebuild-plan.md) and
  [runtime contract](./docs/exec/browser-runtime-contract.md); protocol types
  live in `playwriter/src/browser-protocol.ts`.
- [Pi package README](./pi/README.md) for the tools and install details.
- Extension identity/build: `extension/manifest.json`,
  `extension/vite.config.mts`, `extension/package.json`.
- Runtime package: `playwriter/package.json`.
- Legacy CLI/MCP/Playwright docs: `playwriter/src/skill.md`, `MCP.md`,
  `docs/remote-access.md`.

## Legacy compatibility

The upstream CLI, relay and port `19988` stay available for explicit use:
`pnpm cli:legacy` and `pnpm --filter mcp-extension build:legacy`. Root
`pnpm reload` and `pnpm release` intentionally refuse to run (the old flows
restarted `19988` and targeted the upstream store listing); `pnpm reload:fork`
builds and prints the `chrome://extensions` URL without launching Chrome. The
legacy `playwriter` CLI is never installed as a bin, so it cannot shadow an
upstream global install.

## Upstream and license

Forked from [remorses/playwriter](https://github.com/remorses/playwriter) by
Tommy D. Rossi, [MIT licensed](./LICENSE). Upstream docs for the legacy
CLI/MCP live in `playwriter/src/skill.md`. The pre-rewrite upstream README
(store/npm install, comparisons, sponsor sections) is preserved in Git at
[commit 2346d18](https://github.com/tom-cat-mao/pi-browseruse-playwriter/blob/2346d18/README.md).
