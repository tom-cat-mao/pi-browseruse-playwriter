# Firefox tabs.create 预热失败不再吞掉 tabId

0.0.135。分支 `fix/firefox-tab-create-readiness`，基于 `288c2d0`。

## 现象

`groups.create` 成功后，`tabs.create https://example.com` 返回
`Missing host permission for the tab` · `execution-failed` · `outcome=unknown`，且没有
tabId。原生标签与 registry 记录实际都已存在。

## 根因范围

已确认（代码与运行期证据一致）：

- `tabs.create` 分支先 `commit()` 落盘（`extension/src/firefox-background.ts:898`），再做
  可选的 DOM 预热 `inject()`（原 `:902`）。
- 预热的 `scripting.executeScript` 抛错后，`:604-614` 把它包装成
  `code='execution-failed'`、`outcome = context.started ? 'unknown'`（`:889` 已置 true），
  响应无 `data`，因此模型拿不到 tabId。错误传播路径已确定。
- 该报错字符串来自 Firefox 自身：本机 `omni.ja` 成员
  `chrome/toolkit/content/extensions/parent/ext-tabs-base.js` 的
  `ExtensionTab.queryContent()`，在没有任何匹配 frame 时抛
  `Missing host permission for the tab`（我们传 `frameIds:[0]`，故无 " or frames"）。
  Firefox 源码注释与 TODO bug 2047009 明确写道：当原因是导航/目标被移除时这条报错是
  **误导性**的。
- 归属保留：只读 `tabs.discover` 看到刚创建的 nativeId 142、URL
  `https://example.com/`、title `Example Domain`、`owned-by-other-session`；relay
  inventory 由 `groups=3 tabs=0` 到 revision 7 `tabs=1`。extension-preferences.json 中
  `origins:['<all_urls>']` 已授予。

尚待验证（**不能写成已证实**）：

- 该错误的直接触发究竟是导航中瞬时文档（about:blank/目标 frame 尚未就绪），还是活跃
  注入权限未对注入生效。二者都表现为同一条 Firefox 误导性报错，离线无法区分。
- 用户在原 Pi 会话加载 0.0.135 后回报：建组、创建标签并返回 tabId、截图和
  `browser_execute` 的 `page.title()` 均成功。创建时仍观察到 about:blank 过渡状态。
  snapshot 已进入内容脚本逻辑，但因独立的 `getComputedStyle` Window 接收者错误失败，
  不是原来的 host permission 报错。这证明该轮页面注入并未被权限持续阻断，但不能
  反推出第一次错误瞬间的确切文档状态。完整快照能力仍未通过。

## 修复

- 预热加 `firefoxPageSupported(actual.url)` 条件并 best-effort（失败只 `console.warn`），
  与既有 `tabs.onUpdated`（`:262-265`）一致：已提交的原生 tab 不因可选预热失败而变成
  无 tabId 的整体失败。
- 不关闭/重建原生 tab；`tabs.attach` 仍以注入作为能力探针（`:1169-1176`）；后续
  snapshot/click 等经 `dom()` → `inject()`（`:1346`）仍真实报权限/注入错误，不掩盖。
- 未扩大权限、未自动 `request`、未改 CSP；session/epoch/ledger/原子持久化/取消语义不变；
  未改 group 等无关逻辑。

## 回归

新增纯逻辑用例（`extension/tests/resource-registry.test.ts`）
`Firefox a committed create stays listable and owned when its response is lost`：校验
commit 后失败场景下 `firefoxInventory` 仍列出该 tab、`activeFirefoxTab`/`ownedFirefoxTab`
可恢复归属、其它 session 被拒。浏览器竞态无法用离线测试证明，未新增 mock 或 API 替身。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| 扩展 TypeScript | PASS |
| 扩展测试 | PASS，97 tests / 6 files（新增 1） |
| Pi TypeScript / 测试 | PASS / PASS，3 files |
| runtime TypeScript | PASS |
| 默认 Firefox 构建（`extension/dist-firefox`） | PASS，0.0.135，127.0.0.1:19989 |
| tab-create localhost 构建 | PASS，0.0.135，localhost:19991 |
| 分发包（`pnpm build:firefox`） | PASS，0.0.135，127.0.0.1:19989 |
| Firefox package smoke | PASS，ZIP / unsigned XPI + SHA256 |

runtime unit/integration 未重跑（本次未改 runtime/Pi 代码）。未运行默认会启动 Chrome 的
`pnpm test`。

## 产物

- 默认：`extension/dist-firefox`（0.0.135，127.0.0.1:19989）。
- 本 worktree 现场用：`extension/dist-firefox-tab-create-localhost`
  （0.0.135，localhost:19991），由 `PI_BROWSER_HOST=localhost PI_BROWSER_PORT=19991
  PI_BROWSER_FIREFOX_DIST=dist-firefox-tab-create-localhost` 构建。**未触碰**用户已加载的
  `extension/dist-firefox-lifecycle-localhost`（仍为 0.0.134）。
- 打包：`dist-release/pi-browser-use-firefox-extension-0.0.135.zip` 与
  `...-0.0.135-unsigned.xpi`（附 `.sha256`）。

真实 0.0.135 的建组、创建标签、截图、标题读取已由用户在原 Pi 会话验证成功；snapshot
仍有独立的 Window 方法绑定缺陷，后续单独修复。本实现未加载/重载扩展，未启动真实
浏览器、未改用户权限或已有标签。
