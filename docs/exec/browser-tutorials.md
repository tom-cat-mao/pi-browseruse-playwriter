# 浏览器扩展内置教程页（设计与验收）

本文件记录 Chrome 与 Firefox 两端内置教程页的设计约定、用户入口、打包校验与验收计划。
它是设计与计划记录，不是已交付行为的证明：入口以 `extension/manifest.json`、
`extension/manifest.firefox.json` 与构建产物为准，校验以
[`scripts/package-extension.mjs`](../../scripts/package-extension.mjs) 和
[`extension/tests/extension-package.test.ts`](../../extension/tests/extension-package.test.ts) 为准。

## 设计约定

- 两端各有一个中文本地静态入门页，只用随包提供的 HTML/CSS/JS 渲染；不加载远程资源，
  不为它放宽任何 CSP。
- 教程页本身不自动弹窗、不自动连接 runtime、不接管或创建标签、不启动 runtime。它只说明
  当前产品的安装、配对与既有工作流，所有动作仍由用户或 Pi 工具显式发起。
- 不改变现有 toolbar 的释放/恢复语义，也不改变 Firefox 的可选权限语义；本功能不新增
  任何权限。
- 暖白/深绿视觉，覆盖深色模式与窄屏，主要入口具备键盘语义（可聚焦、有可读名称）。
- 内容对应当前 Pi Browser Use：源码安装 Pi 包 → 配对本地 managed runtime →
  `browser_profiles` → `browser_tabs` 的 `discover`/`attach` → `browser_snapshot` →
  `browser_tabs` 的 `release`。不再出现 `npx playwriter` 那套旧 CLI 流程。

## 用户入口

| 浏览器       | 教程页                  | 入口                                                                                                                                         |
| ------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome       | `src/tutorial.html`     | `manifest.json` 的 `options_ui`（`open_in_tab: true`）：`chrome://extensions` 扩展详情里的扩展程序选项，或图标右键菜单的“选项”               |
| Firefox 139+ | `firefox-tutorial.html` | `manifest.firefox.json` 的 `options_ui`（`open_in_tab: true`）：`about:addons` 里的“选项/首选项”；扩展弹出页另有一个指向该本地页面的帮助链接 |

本功能没有新增任何自动打开路径，但两处既有行为需要如实说明：Chrome 开发构建在“runtime 空闲时
点击图标”这个本功能之前就存在的路径上会打开 `src/tutorial.html`；`onInstalled`（安装时）那条既有
路径原本打开 `src/welcome.html`，而 `welcome.html` 已随本功能删除，因此改为调用同一个
`openTutorialPage()`。runtime 包与 `dist-release` 里的归档在构建时设置
`PLAYWRITER_OPEN_WELCOME_PAGE=0`，这两条路径都不会触发。Firefox 端不存在任何自动打开路径。
教程页本身不连接 runtime、不接管或打开标签、不启动 runtime，只显示静态说明。

## 打包校验

`scripts/package-extension.mjs` 在写出 ZIP/XPI 之前，校验 manifest 声明的本地入口：
`background.service_worker`、`background.scripts`、`action.default_popup`、
`options_ui.page`、`options_page`、`icons`、各 `default_icon`，以及每个 HTML 页面引用的本地
`<script src>` / `<link href>` / `<img src>` / `<a href>`。manifest 入口必须是**非空、且真实存在
于 bundle 内的本地路径**：远端地址、空字符串、越出包外的相对路径、非字符串类型都会以非零退出失败，
不会被忽略后照常打包；页面引用的本地文件缺失同样直接失败。HTML 里显式的外链（`https:`、`mailto:`、
`#fragment`）只作为链接看待，不会因为不是本地资源而被误判。权限、CSP 与既有文件校验保持不变，没有为
教程放宽规则。

`options_ui` 一旦存在就必须是对象（非 `null`、非数组）且声明 `page`，否则直接失败：容器类型错误
或缺 `page` 不会被静默跳过（校验函数 `assertOptionsUiShape`），`page` 的取值继续走上面那套非空
本地路径校验。

`welcome.html` 与 Prism 一起移除后，Prism 已没有任何消费者，因此同时删除了
`extension/scripts/download-prism.ts`、`build-extension.mjs` 里的下载步骤，以及打包脚本里只断言
Prism 文件存在的检查。构建现在会先清空自己的输出目录，避免已删除的页面或资源残留在可加载目录里
并被带进归档；`extension/scripts/build-extension.mjs` 只接受 `dist` 或 `dist-<suffix>` 形式的 Chrome
输出目录，并显式拒绝 Firefox 目录，因此 `PLAYWRITER_EXTENSION_DIST=src`（或任何源码目录、父目录、
嵌套路径）会在删除任何文件之前直接失败。

## 验收状态

本节把两类证据分开标注，不把复核结论当成实现记录：

- **实现证据**：本功能实现者在集成 worktree（`feat/browser-tutorials`）上以最终源码真实运行，
  日志在本地 `tmp/final/` 与收尾时的 `tmp/tutorials-finish/`（都不随源码版本化）。
- **独立复核证据**：未参与实现的独立 agent 在只读约束下重跑并独立复现，记录在
  `tmp/independent-tutorial-final-review.md`（同样不随源码版本化）。该文件同时记录两轮结论：
  **第一轮**针对收尾四项修正之前的同一工作区（HEAD `cc56026`，未提交改动 28 项），复现的是修订前
  计数（**首轮历史值：187 / 10、17 tests**）；**第二轮窄复核**针对四项修正后的工作区，复现并关闭
  F-1~F-4，独立复现了 `mcp-extension` **192 / 10**、`options_ui` 容器形状 **5 个负例**、全量独立
  负例 **28 个零失败**、双端打包与 SHA（各连续两次同值、XPI 与 ZIP 字节相同）以及归档独立核对无
  问题。第二轮未重跑 runtime / pi 套件与完整 `pnpm build`（源码未触及这些路径），这些沿用第一轮结论。

两端实现（Chrome 7 项改动 + Firefox 6 个文件）均已导入，两份 manifest 同步为 `0.0.139`。
表中“证据”列的 `实现 + 独立复核` 表示独立复核重跑过该检查（括号内注明首轮或第二轮），
`仅实现` 表示独立复核按约束跳过（例如会拉起进程的 `smoke`）。

| 检查                                                             | 结果                                                                                            | 证据                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm --filter @tom-cat/pi-browser-runtime typecheck`            | PASS                                                                                            | 实现 + 独立复核                                                                       |
| `pnpm --filter @tom-cat/pi-browser-runtime test:unit --run`      | PASS，293 tests / 22 files                                                                      | 实现 + 独立复核                                                                       |
| `pnpm --filter @tom-cat/pi-browser-runtime test:integration`     | PASS，34 tests / 4 files                                                                        | 实现 + 独立复核                                                                       |
| `pnpm --filter mcp-extension test --run`                         | PASS，192 tests / 10 files                                                                      | 实现 + 独立复核（第二轮复现 192 / 10；首轮 187 / 10 为历史值）                        |
| `pnpm --filter mcp-extension exec tsc --project .`               | PASS                                                                                            | 实现 + 独立复核                                                                       |
| 构建目录白名单回归（真实临时 fixture，含符号链接用例）           | PASS，20 cases：拒绝源码/父目录/嵌套/Firefox 目录且不删除任何文件                               | 实现 + 独立复核                                                                       |
| 打包入口负例（远端、空、越界、错误类型、缺失页面与本地链接）     | PASS，该文件 22 tests（含 17 个负例）；HTML 显式外链不误伤                                      | 实现 + 独立复核（第二轮复现 22 tests 与 28 个独立负例零失败；首轮 17 tests 为历史值） |
| `options_ui` 容器形状负例（字符串/数组/数字/null 或缺少 `page`） | PASS，5 tests：exit≠0 且不产出归档；去掉该校验后同样输入被静默接受（见下方回归证明）            | 实现 + 独立复核（第二轮独立 CLI 复跑 5/5 exit≠0）                                     |
| `pnpm --filter @tom-cat/pi-browser-use-extension test --run`     | PASS，97 tests / 3 files                                                                        | 实现 + 独立复核                                                                       |
| `pnpm --filter @tom-cat/pi-browser-use-extension typecheck`      | PASS                                                                                            | 实现 + 独立复核                                                                       |
| `pnpm --filter @tom-cat/pi-browser-use-extension load-check`     | PASS；12 tools、browser-status、session_shutdown                                                | 实现 + 独立复核                                                                       |
| `pnpm build`（runtime + 两端扩展 bundle）                        | PASS；不再有任何构建期网络下载                                                                  | 实现 + 独立复核                                                                       |
| `pnpm --filter @tom-cat/pi-browser-runtime smoke`                | PASS；`eeklahpecooapnailfaebkjjembkjhhg` on 19989                                               | 仅实现（独立复核 SKIP：会拉起 runtime 进程）                                          |
| `pnpm package:extension`（Chrome ZIP）                           | PASS，`dist-release/pi-browser-use-extension-0.0.139.zip` + `.sha256`；连续两次打包 SHA256 一致 | 实现 + 独立复核（第二轮复现：各连续两次同值）                                         |
| `pnpm package:firefox`（Firefox ZIP + 未签名 XPI）               | PASS，两个归档各带 `.sha256`；连续两次打包 SHA256 一致，XPI 与 ZIP 字节相同                     | 实现 + 独立复核                                                                       |
| 归档解压复核（入口、页面资源、版本、SHA、无 Prism/welcome）      | PASS，36/36                                                                                     | 实现 + 独立复核（第二轮独立归档核对无问题）                                           |

归档的具体 SHA256 不写进本文件：它随页面内容变动，以 `dist-release/*.sha256` 与打包日志为准；
这里只记录“连续两次打包同值”这一可重复性结论。

安装路径与非打包产物的核对（`tmp/verify-firefox-tutorial-integration.mjs`，18/18 PASS，本次收尾
重跑）：两端 `options_ui` 指向的页真实存在、来源页引用的本地 css/js 存在、教程页除仓库外链外不
加载任何远程资源、没有内联脚本或内联事件处理器、popup 教程链接带 `noopener noreferrer`、归档里
没有残留 TS 源码。

打包负例（对真实 bundle，必须失败才算通过；`extension/tests/extension-package.test.ts` 的 22 个
入口用例（17 个负例）+ `tmp/negative-package-checks.mjs` 的 14 个负例 + 1 个正向）。第二轮独立复核
用自己的 fixture 跑真实 CLI：容器形状与缺 `page` 共 5 例全部 exit≠0、不产出归档，全量独立负例
`NEGATIVE=28 NEGATIVE_FAILURES=0` 且正向用例通过——第一轮该容器用例 exit=0 的缺口已封：

| 负例                                                             | 结果                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `options_ui.page` 指向不存在的页面                               | PASS（exit 1，`manifest.json options_ui.page references missing packaged file …`） |
| `options_ui.page` 是远端地址 / 协议相对地址                      | PASS（exit 1，`must be a packaged local file`）                                    |
| `options_ui.page` 是空字符串                                     | PASS（exit 1，`must be a non-empty string`）                                       |
| `options_ui.page` 越出包外（`../`）或绝对路径                    | PASS（exit 1，`points outside the package` / `references missing packaged file`）  |
| `options_ui.page` 类型错误（数字、数组、null）                   | PASS（exit 1，`must be a non-empty string`，不再被当作列表展开而漏检）             |
| `options_ui` 容器不是对象（字符串、数组、数字、`null`）          | PASS（exit 1，`manifest.json options_ui must be an object with a page`）           |
| `options_ui` 对象缺少 `page`                                     | PASS（exit 1，`manifest.json options_ui must declare a page`）                     |
| `action.default_popup` 越出包外                                  | PASS（exit 1，`manifest.json action.default_popup points outside the package: …`） |
| 删除 bundle 里的教程页                                           | PASS（exit 1，入口校验先失败）                                                     |
| 页面引用未打包的本地 `<link href>` / `<script src>` / `<a href>` | PASS（exit 1，`firefox-popup.html references missing packaged file …`）            |
| HTML 里的显式外链与 `#fragment`                                  | PASS（正常打包，未被误判为缺失的本地资源）                                         |

容器形状负例的回归证明（`tmp/tutorials-finish/06-prefix-skip-proof.mjs`，4/4 PASS）：把
`assertOptionsUiShape` 从打包脚本里去掉后，同一批畸形 manifest 会被静默接受（`accepted`），
加回该校验后全部被拒绝，说明这两个负例确实拦住了此前会漏过的情况。

构建输出目录负例（真实临时 fixture，`extension/tests/extension-build-outdir.test.ts`）：`src`、
`scripts`、`tests`、`test-fixtures`、`icons`、`.`、`..`、`../src`、`dist/../src`、`src/dist`、
`/absolute`、`dist/nested`、`dist-firefox`、`dist-firefox-1`、`DIST`、`dist-`、`dist-../src` 全部被
拒绝且不删除任何文件；允许的 `dist-<suffix>` 会被清空；当输出目录是指向包外目录的符号链接时，只删除
链接本身，包外目标文件保留。这些用例只在临时 fixture 上运行，产品 `extension/src` 从未被当作该变量的
取值对象。

仍未运行（SKIP，需要用户准备浏览器并加载扩展，属浏览器阶段）：

- 两端教程页在真实浏览器里的打开路径、渲染、深色/窄屏布局与键盘可达性。
- `options_ui` 在真实 `chrome://extensions` / `about:addons` 里的入口点击。
- Chrome 的 `onInstalled` 开发构建路径与空闲图标路径在真实浏览器里的实际打开行为。

未运行的项目按 SKIP 记录，不能标记为 PASS，也不能只用打包成功代替浏览器验收。
