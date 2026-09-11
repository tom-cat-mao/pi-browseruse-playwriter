---
title: Browser 可靠性修复阶段独立审查
description: 记录已集成 runtime、Pi 和扩展补丁的独立审查问题与待复验项。
prompt: |
  用户授权多 agent swarm 修复并要求最后仅合入开发分支 dev。
  全新 Codex 对 dfedbdc..a599f8d 做只读独立阶段审查，不构建、不测试、
  不启动 Chrome，不把尚未集成的 executor/ARIA 旧问题当成本轮回归。
  依据 @docs/exec/browser-reliability-plan.md @AGENTS.md
  @playwriter/src/managed-relay.ts @playwriter/src/cdp-relay.ts
  @playwriter/src/runtime-network-capture.ts @playwriter/src/managed-relay.test.ts
  @extension/src/managed-groups.ts @pi/extensions/index.ts
  @pi/extensions/ui-format.ts @pi/extensions/page-context.ts
  @pi/extensions/runtime-client.ts @pi/test/index.test.ts。
---

# 范围与结论

候选：`a599f8d`；基线：`dfedbdc`。独立 reviewer：全新 Codex 会话 codex-7。
这是阶段审查，不是最终验收。发现两个 P1、一个 P2，已由协调者对照源码
确认并退回 owner；当前不能宣称通过。executor/ARIA 尚未集成，Chrome
尚未准备或运行。

# 问题

| ID | 优先级 | 证据与复现序列 | 状态 |
| --- | --- | --- | --- |
| R1 | P1 | managed-relay.ts 的 network start 在等待 Network.enable 前 deleteTab；旧 capture 有 POST200 证据时，新 start 失败/取消/超时会提前丢失旧记录 | 退回 runtime owner |
| R2 | P1 | network start 在 profile queue/enable 等待，stop 直接处理；stop 返回 inactive 后，较早 start 仍可能完成并重新激活收集 | 退回 runtime owner |
| R3 | P2 | Pi session_shutdown 无参数 pageContext.clear() 清掉所有 session，而不是只清当前 session | 退回 Pi owner |

R1 要求新 capture 成功提交时才原子替换旧证据；不能用失败的 start 清空。
R2 要求 stop/cancel 对排队及进行中的 start 都生效，且 stop 不应排在挂起的
页面操作后等待。R3 必须从真实 shutdown hook 验证 A 退出不清 B 的上下文。

# 已检查的正向结果

- capture 位于 runtime，有界元数据缓冲不依赖执行 worker。
- connection/root CDP session/source CDP session 为捕获与 requestId 提供隔离。
- 新 networkCapture/pageInfo 为可选字段；旧 value 形状不变；进入模型 content。
- discovery 分页 nextOffset 基于实际返回条数，分页参数不传给旧 runtime。
- Pi 折叠摘要/错误清理真实控制码，不缩短模型侧稳定 ID。

上述仅为源码审查结论，不替代运行验证。协调者已在该候选运行 runtime
类型检查与 49 项聚焦测试、Pi 类型检查与 91 项测试及 12-tool load-check；
扩展 43 项纯测试通过。HTTP/WS 套件仍使用仓库已有 fake extension/pool，
不是实际 Chrome 行为证明。

# 后续

修复提交到集成分支后由 reviewer 复验 R1/R2/R3；executor/ARIA 合入后另做
完整独立验收。需要 Chrome 时先告知用户并等待准备确认。通过后 PR 目标
只能是 dev；main、当前 Pi 安装及运行中的 runtime 不变。
