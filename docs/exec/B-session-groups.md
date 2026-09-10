# 工作流 B：per-session 标签组（扩展 + relay + 协议）

目标：把现有"全局单一 playwriter 组"升级为**按 CLI session 分组**：每个 playwriter session 的标签独立编组（组名=session 名、颜色轮转），session 删除后组保留供审查，仅显式 close 才关闭标签。供 pi 的 session↔标签组 1:1 映射语义（对齐 Kimi WebBridge / Codex for Chrome 的产品形态）。

## 背景（已侦察）

- 现状组逻辑：`extension/src/background.ts` `syncTabGroup()`（:892-962）：所有 connected 标签进一个绿色 "playwriter" 组；拖入=attach、拖出=detach（:2023-2050 的 onUpdated 守卫）；断线时清理组（注意代码注释中两处循环防护不变量）。
- relay 侧 session/target 注册：`playwriter/src/relay-state.ts`；`/cli/session/new` 在 `cdp-relay.ts:2064`。
- 协议：`playwriter/src/protocol.ts`（extension↔relay WS 消息，forwardCDPCommand/Event 等）。

## 设计（建议路径，允许等价替代，但必须满足"不变量"）

1. **session 元数据**：`/cli/session/new` body 接受 `{name?, color?}`；relay 存 sessionMeta（id→{name,color}），并持久到内存注册表。新增 `GET /cli/capabilities` → `{sessionGroups:true, consent:<C 完成状态>, audit:<…>, closeTabs:true}`。
2. **session→tab 绑定**：relay 维护 sessionId→Set(tabId/targetSessionId)。来源：该 session 的 executor 解析/创建的 page（`context.newPage()` 经 CDP Target.createTarget、`state.page` 赋值时的 target）。绑定变化时经 WS 推送给 extension：新消息 `{method:'sessionBinding', params:{playwriterSession, name, color, tabSessionIds:[…]}}`（全量推送，幂等）。
   - 备选等价路径：execute 时 relay 已知本次目标 tab（executor 解析 page 的 target），就地更新绑定再推送。选你认为最干净的，但**绑定必须覆盖 newPage 新建标签**。
3. **extension 分组**：store 的 tab info 增加 `playwriterSession`；`syncTabGroup()` 重构为按 session 分组：
   - 每 session 一个组：标题=name（缺省 `playwriter-<id>`），颜色从调色板轮转（保留绿色给缺省/未绑定标签）。
   - **保留拖入=attach、拖出=detach 语义**（拖到某 session 组即归入该 session）。
   - 未绑定到任何 session 的受控标签仍进原 "playwriter" 组（向后兼容）。
4. **生命周期**：`/cli/session/delete` → 标签与组**保留**（审查语义，Codex 式）；新增 `POST /cli/session/close-tabs {sessionId}` → 关闭该 session 全部标签并解组。
5. **协议兼容**：新消息双向容错（unknown method 忽略）；不 bump 破坏性版本。

## 不变量（不得破坏，需配测试）

1. relay 断开时：connecting 标签的组清理行为与现状一致（见 syncTabGroup 注释的两个循环防护）。
2. 拖入/拖出 attach/detach 语义不变；restricted URL（chrome:// 等）不入组。
3. 旧扩展连新 relay / 新扩展连旧 relay 均正常（unknown 消息忽略）。
4. `pnpm --filter playwriter test` 全绿；新增逻辑（分组归属计算、绑定更新）有 vitest 单测（尽量抽纯函数，参照现有 relay-state.test.ts / 现有组逻辑可测性）。

## 验收（agent 必须亲自执行并附证据）

1. 单测全绿（新增 + 现有）。
2. 构建：`pnpm --filter playwriter build` 与 `cd extension && pnpm build` 成功。
3. 隔离浏览器端到端：用 worktree 构建产物 `playwriter browser start`（加载本地构建的扩展，见 browser-launch.ts `--load-extension`）→ 建两个 session（`session new`，各带 name）→ 各 `newPage` 打开两个不同 url → 断言：`GET /cli/capabilities` 返回 sessionGroups:true；relay 绑定注册正确；`close-tabs` 关闭对应标签。
   - 浏览器内组状态的断言如无法自动化，用 CDP 查询或截图佐证，并在报告中说明验证方式与截图路径。
   - **禁止触碰用户日常 Chrome 与 19988 上运行的 relay**；测试 relay 用别的端口（PLAYWRITER_PORT env）。
4. 旧扩展（用户 Chrome 里的上游版）连新 relay 的兼容性：本地起新 relay（非 19988 端口），说明兼容性论据（代码路径）即可，不要求真连。

完成后按 00-overview.md 的报告格式输出。
