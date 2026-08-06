# pi-browser-use-extension — 总览与集成契约

目标：把本仓库（playwriter fork）改造为 pi 的 browser-use 扩展包 `@tom-cat/pi-browser-use-extension`（pi package，可 `pi install`），一步到位实现：pi 类型化工具层（A）、per-session 标签组（B）、授权边界与审计（C）。

## 架构现状（已侦察，可信）

**relay server**（`playwriter/src/cdp-relay.ts`，Hono，127.0.0.1:19988）：
- `POST /cli/session/new`（body 宽松解析，未知字段安全，cdp-relay.ts:2064）
- `POST /cli/execute` `{sessionId, code, timeout, cwd}` → `{text, images:[{data,mimeType}], screenshots:[{path,base64,snapshot,labelCount}], isError}`
- `GET /version` → `{version}`；`GET /extension/status`、`GET /extensions/status`
- localhost 默认无 token（token 仅在绑 0.0.0.0 时强制）
- session/target 注册表：`playwriter/src/relay-state.ts`（含 `getTabBySessionId`）

**Chrome 扩展**（`extension/src/background.ts`，2454 行）：
- attach：点 action 图标 或 把标签拖入 "playwriter" 组（background.ts:2023-2050）
- 已有**全局单一**标签组 `syncTabGroup()`（background.ts:892-962，绿色，标题 "playwriter"）
- CDP auto-attach 处理 OOPIF（:1065-1082）；`getTabBySessionId`（:975+）
- manifest 已有 `tabGroups` 权限

**执行沙箱**（`playwriter/src/executor.ts`）：`page`/`context`/`state`（跨调用持久）/`require` 在作用域内；helper 含 `snapshot({page})`、`screenshotWithAccessibilityLabels({page})`、`getLatestLogs({page, sinceLastCall:true})`、`getCDPSession({page})`。

**构建**：pnpm workspace；`pnpm bootstrap` = submodule init + pnpm install + playwright build。playwriter 构建用 bun scripts（bun 已装）。扩展构建：`cd extension && pnpm build`（vite）。
**`playwriter browser start` 用 `--load-extension=<本地构建的 extension dist>` 启动独立 Chrome for Testing**（browser-launch.ts:37-38）—— 这是扩展改动的隔离验收路径，不碰用户日常 Chrome。

## 集成契约（A 与 B/C 之间的接口，双方必须遵守）

1. `POST /cli/session/new` body 允许新增可选字段 `{name?, color?, icon?}`：stock relay 忽略未知字段（已验证宽松解析），B 必须保持向后兼容。
2. B 新增 `GET /cli/capabilities` → `{sessionGroups: bool, consent: bool, audit: bool, closeTabs: bool}`。A 通过它做特性探测，**缺失时静默降级**，禁止硬依赖。
3. B 新增 `POST /cli/session/close-tabs {sessionId}` → 关闭该 session 绑定的标签。A 降级路径：execute 代码片段 `await Promise.all(context.pages().map(p=>p.close()))`。
4. 协议消息（extension↔relay，protocol.ts）：新增消息类型必须双向容错（旧扩展连新 relay、新扩展连旧 relay 均不得崩溃；unknown method 忽略）。
5. A 的 pi 包零 runtime dependencies（只用 fetch/Node 内置 + pi peerDeps）。

## 验收环境

- 用户 Chrome 已装上游 Playwriter 扩展且常连（`/extension/status` → connected:true）。**禁止**重启/杀死 19988 上正在运行的 relay，**禁止**操作用户日常 Chrome 的标签。
- 扩展改动验收一律走 `playwriter browser start`（Chrome for Testing 隔离实例）。
- 基线狗食任务（A 验收用）：打开 `https://ads.tiktok.com/creative`，注入 header `x-use-ppe: 1` + `x-tt-env: ppe_pe_traffic_lift`（`await context.setExtraHTTPHeaders({...})` 后 reload），截图返回。

## 工作流约束（两个 agent 共同遵守）

- 在分配的 git worktree 内工作，改动提交到该 worktree 的分支，commit message 清晰；**不得 push、不得动 main、不得改另一个 worktree**。
- 不改动 website/、docs/（营销文档）、README 上游部分；新增代码配 vitest 单测。
- 现有测试不得破坏：`pnpm --filter playwriter test`（B/C agent 必须跑绿；A agent 如无依赖可不跑）。
- 完成后输出报告：变更清单、测试/构建结果、已执行的验证、已知限制、commit hash。
