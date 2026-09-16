# Firefox loopback WebSocket 修复

## 根因与范围

0.0.132 的 Firefox MV3 manifest 没有显式 CSP。Firefox background 先通过
`http://<loopback>/extension/firefox-handshake` 获取 ticket，再构造 `ws://` URL；
relay 使用 plain HTTP server，未提供 TLS。现场报告 HTTP handshake 成功且 ticket
不断更新，但 Firefox 报错 URL 为 `wss://localhost:19991/extension`，换成 127.0.0.1
仍失败。

[MDN 官方说明](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy#upgrade_insecure_network_requests_in_manifest_v3)
明确指出 Firefox MV3 默认策略包含 `upgrade-insecure-requests`，需要 `http:`/`ws:`
的扩展可显式指定不含该指令的 CSP。协调者另已核对本机 Firefox 155.0.1 的
`omni.ja!greprefs.js` 默认策略与之相同。这解释了源码 `ws:` 被升级为 `wss:`、
随后无法连接 plain HTTP relay 的现象。用户加载修复产物后，已确认真实 Firefox
WebSocket 连接成功并完成 profile 上报；页面操作与长时间连接保持仍待验收。

0.0.133 显式设置扩展页策略为 `script-src 'self'; object-src 'self';`。脚本仍限于
扩展内打包文件，不允许 eval、inline 或远端代码。Firefox 构建与打包共用严格 CSP
检查，缺失策略、重新加入升级指令或放宽脚本来源均会失败；原有打包验证继续执行。
Chrome manifest 仅同步版本。未改动连接代码、认证、ticket、Origin、Host 或资源隔离。

## 浏览器无关验证

命令均从本 worktree 运行，使用缓存的 pnpm 10.18.1。新 worktree 的 bootstrap
首次因 Git 禁止本地 file transport 失败；仅对重试命令允许本地子模块传输，离线
安装并构建成功。子模块保持 `2074cbb1d4d3ce9274ec10c7d7834d4a7aba1d64`。
移除 bootstrap 产生的本任务无关 lockfile 变化后，另以
`pnpm install --offline --frozen-lockfile` 成功核验依赖。

验证结果与完整日志记录在本 worktree 的 `tmp/logs/`：

- `pnpm --filter @tom-cat/pi-browser-runtime build`：PASS。
- `pnpm --filter mcp-extension test --run`：PASS，6 个文件、95 项测试。
  新增用例读取真实 manifest，并在临时目录执行真实构建/打包脚本；覆盖合法策略
  的 ZIP/XPI smoke、缺失策略、升级指令及不安全脚本来源。所有 fixture 均清理。
- `pnpm --filter mcp-extension exec tsc --project .`：PASS。
- `pnpm build:firefox` 与上述环境变量指定的 localhost 构建：PASS。
- `pnpm package:firefox`、`pnpm package:extension`：PASS；包括归档解包、内容验证与
  SHA256 校验。Firefox ZIP 与 unsigned XPI 均成功。
- `pnpm --filter @tom-cat/pi-browser-runtime test:unit --run src/managed-relay.test.ts`：
  PASS，58 项；包含 Firefox plain HTTP→WS 握手、token、origin-bound/single-use
  ticket 与 backend 隔离回归。该端口套件独立串行执行。

Node WS 测试使用显式 Origin，验证的是 relay 真实握手与鉴权，不执行 Firefox CSP，
也不能据此声称 Firefox 与 Chrome 全面对等。协调者另已重跑扩展 95 项测试、扩展
TypeScript 检查及 managed relay 58 项测试，均通过；日志为 `tmp/logs/coordinator-*`。

## 已完成的真实连接验证

用户在已有 Firefox 中手工加载修复产物后，协调者只读检查实际 runtime：

- `/extensions/status` 返回 Firefox 连接，扩展版本为 `0.0.133`。
- `/browser/v1/profiles` 返回 Firefox profile，`connected: true`，后端为 `webextension`。
- runtime 日志确认收到 Firefox inventory，而非仅有 HTTP 健康检查成功。
- 当时没有受控标签，未操作用户页面；此结果只证明实际连接与资源上报成功。

## 后续浏览器验收

默认构建为 `extension/dist-firefox`，发行副本为
`playwriter/dist/extension-firefox`，目标 `127.0.0.1:19989`。
另提供本 worktree 的 `extension/dist-firefox-localhost-fix/manifest.json`，通过
`PI_BROWSER_HOST=localhost PI_BROWSER_PORT=19991 PI_BROWSER_FIREFOX_DIST=dist-firefox-localhost-fix`
构建，供现场使用；不会覆盖相邻 integration worktree 的用户加载目录。

后续通过 Pi 工具验证连接保持与结构化 DOM 操作，只使用用户明确指定的页面或自建
fixture，并确认未授予 userScripts 时 evaluate 的既有限制仍在。不得在日志中记录
完整 ticket/token。连接成功不代表截图、输入、网络、evaluate 或 execute 均已实测通过。
浏览器扩展由用户手工加载；实现与验证过程未修改用户设置或重启 19989/19991 进程。
