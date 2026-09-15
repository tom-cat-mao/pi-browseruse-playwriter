# Firefox MV3 后台生命周期修复

0.0.134。分支 `fix/firefox-background-lifecycle`，基于 `codex/firefox-extension` 的
`afe3a5d`。

## 现象与根因

用户加载 0.0.133 localhost 修复产物后，真实日志显示：在任何创建组操作之前，扩展已反复
约每 60s 连接 → code 1001 关闭 → alarm 唤醒；`about:debugging` 显示后台 Stopped。
`profiles.list` 报 connected 后，紧接着的 `groups.create` 可能报 profile-disconnected。

根因是 Firefox 非持久 MV3 后台的休眠语义，与 0.0.133 的 CSP/loopback 修复无关：

- 非持久后台在无 Firefox 认可的活动时，`extensions.background.idle.timeout` 默认 30s
  （`parent-ext-backgroundPage.js` 约 :27-35），到期后终止后台并置 Stopped。
- 来自后台上下文的 parent API 调用会触发 `background-script-reset-idle`
  （`reason: "parentapicall"`，`ExtensionParent.sys.mjs` 约 :1298-1307），并重置 idle
  timer（`parent-ext-backgroundPage.js` 约 :776-825）。parent API 调用只是 Firefox
  认可的活动之一，事件、native messaging 等同样可以重置，裸 WebSocket 往返不计入。
- relay 每 5s 发 `{ method: "ping" }`（`playwriter/src/cdp-relay.ts:293-308`），而扩展
  原先只回 `socket.send(pong)`（旧 `extension/src/firefox-background.ts:446-449`）。
  裸 WebSocket 往返不在这类活动内，因此仅回 pong 的 ping 无法阻止 30s 休眠。
- 后台被终止后，60s 的 `pi-firefox-runtime-reconnect` alarm（`firefox-background.ts:161`）
  才重新唤醒并重连，形成约 60s 的连-断循环；断线窗口内的 `groups.create` 会失败。

这与 MDN
[Background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)
一致：MV3 Firefox 只有 non-persistent 后台，DOM 计时器不能在停止后唤醒，不能
`persistent: true`。

## 最小修复

- 新增 `extension/src/firefox-keepalive.ts`：`keepFirefoxBackgroundActive` 调用一次只读
  parent API `runtime.getBrowserInfo()`（parent 实现见 `parent-ext-runtime.js:335`，仅读
  `Services.appinfo`），从而触发 `parentapicall` idle 重置；不改变任何状态、不新增权限。
  失败（同步抛错或 Promise 拒绝）一律被吞掉并只打 `console.debug`，不会成为未捕获拒绝。
- `extension/src/firefox-background.ts` 的 ping 分支：先发起一次 keepalive（不 await），
  再向当前 socket 回 pong。pong 只在 `options.socket === this.socket` 且 OPEN 时发送，
  过期/替换 socket 不会被写入。
- runtime 连接期间每 5s 的 ping 即每 5s 一次 parent 活动（相对 30s 阈值有 6x 余量）；
  runtime 断开后 ping 停止，后台恢复可休眠，现有 60s alarm 仍能唤醒并重连。
- 未引入：常驻 timer、后台常驻页、新权限、Firefox 偏好更改、全局共享状态；未改认证、
  Origin/Host、loopback 握手与 CSP。未重放任何动作。

## epoch / ownership

休眠唤醒本身不改变归属：`storage.session` 在同一浏览器会话内跨后台终止/重启保留
（仅浏览器关闭或扩展重载/更新时清空），因此 `EPOCH_KEY`（`storage.session`）不变，同 epoch
`reconcileFirefoxRegistry` 保留 ready 的 tab/group 与 ownership。扩展重载或真实浏览器
重启仍会生成新 epoch 并将旧记录置 `needs-rebind`，`ownedFirefoxTab` 继续拒绝复活旧资源。
核查未发现 epoch bug 证据，故未改语义，只补回归：新增
`tests/resource-registry.test.ts` 中「background suspension keeps ownership while a lost
session epoch still rebinds」。

## 验证结果与剩余边界

- **高置信（代码复核 + 离线回归）**：ping 分支现在每次都会调用一个只读 parent API，
  调用失败被吞、不会未捕获，pong 仅发往当前 socket（代码复核，未为其新增 API 替身测试）；
  同 epoch 保留归属、异 epoch 仍 `needs-rebind`（真实 `reconcileFirefoxRegistry` 回归）；
  构建产物为 0.0.134，CSP 与 loopback 地址未变。
- **真实连接与操作 PASS**：用户加载 0.0.134 后，协调者通过真实 runtime 完成约 96 秒
  观测，25 次采样均为 connected，WebSocket connectionId、browserEpoch 与版本不变。
  空闲观察前后各执行一次 `groups.create`，均成功；两组均由同一验收 session 关闭，
  未创建或接管用户页面。观察期间只读取 runtime 缓存状态，不发送页面操作来维持后台。
- 首次检查发现一个当前在线 profile 和一个旧的离线缓存 profile，因此在任何创建操作前
  拒绝歧义选择。随后读取实际连接信息并显式指定新 profile，才执行上述验收。
- **尚未验证**：运行中断开 runtime 后的休眠/重新唤醒、系统休眠恢复、长时间运行以及
  页面输入/截图/evaluate/execute。验收要求关闭扩展 Inspector；HTTP 检查本身不确认
  调试器是否附着，也不直接追踪 Firefox 内部 `parentapicall` 事件。
- 证据与验收脚本保存在本 worktree 的 `tmp/live-lifecycle-*.json` 和
  `tmp/live-lifecycle-check.mjs`；PASS 记录包含所有采样、两次创建及两次成功关闭。

## 浏览器无关验证

命令均从本 worktree 运行，pnpm 为缓存的 10.18.1，子模块固定
`2074cbb1d4d3ce9274ec10c7d7834d4a7aba1d64`；`pnpm install --offline --frozen-lockfile`
成功。完整日志在 `tmp/logs/`。

| 检查 | 实际结果 |
| --- | --- |
| 扩展 TypeScript（`mcp-extension exec tsc`） | PASS |
| 扩展测试（`mcp-extension test --run`） | PASS，96 tests / 6 files（新增 reconcile ownership/epoch 1） |
| Pi TypeScript | PASS |
| Pi 测试 | PASS，97 tests / 3 files |
| Pi load-check | PASS，12 tools、browser-status、session_shutdown |
| runtime build | PASS |
| runtime TypeScript | PASS |
| runtime unit | PASS，293 tests / 22 files |
| runtime integration | PASS，34 tests / 4 files |
| 默认 Firefox 构建（`extension/dist-firefox`） | PASS，0.0.134，127.0.0.1:19989 |
| lifecycle localhost 构建 | PASS，0.0.134，localhost:19991 |
| 默认 Firefox 分发包与打包 smoke（`pnpm build:firefox`、`pnpm package:firefox`） | PASS，0.0.134，ZIP / unsigned XPI + SHA256 |

四套测试合计 520 项。未运行默认会启动 Chrome 并更新快照的 `pnpm test`。keepalive 路径的失败
吞并、socket 守卫与 ping 接线只由代码复核，没有为它新增 API 替身测试，也不以它证明 Firefox
真实活动。

## 产物

- 默认：`extension/dist-firefox`（0.0.134，127.0.0.1:19989），以及分发包
  `playwriter/dist/extension-firefox`。
- 打包 smoke：`dist-release/pi-browser-use-firefox-extension-0.0.134.zip` 与
  `...-0.0.134-unsigned.xpi`（附 `.sha256`）。
- 本 worktree 现场用：`extension/dist-firefox-lifecycle-localhost`，由
  `PI_BROWSER_HOST=localhost PI_BROWSER_PORT=19991 PI_BROWSER_FIREFOX_DIST=dist-firefox-lifecycle-localhost`
  构建。不会覆盖用户在 `firefox-ws-fix` worktree 已加载的
  `extension/dist-firefox-localhost-fix`。

Firefox 扩展由用户手工加载。协调者已完成上面的持续连接和空闲前后创建组验收，
只创建并关闭本次验收自己的两个逻辑组；没有操作用户已有页面，没有启动或重载浏览器、
后台服务，也没有修改 Firefox 设置或重启 runtime。
