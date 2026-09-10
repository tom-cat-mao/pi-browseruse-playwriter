---
title: Pi Browser Use 中期独立审查记录
description: 新 agent 只读审查发现与修复责任，非最终验收。
prompt: |
  汇总全新 codebuddy-12 对集成树的只读审查与协调者核验。
  依据 @docs/exec/browser-rebuild-plan.md
  @docs/exec/browser-runtime-contract.md
  @extension/src/background.ts @extension/src/managed-groups.ts
  @extension/src/resource-registry.ts @extension/src/resource-storage.ts
  @playwriter/src/managed-relay.ts @playwriter/src/cdp-relay.ts。
  必须区分安全降级与功能完成，不操作真实 Chrome，不假称实测。
---

# 审查范围

全新 codebuddy-12，只读。A b3fa70b、B0364558、E4500349后的集成源码。
C worker / D新Pi工具未完成，不把缺失模块列为这次审查的重复缺陷。
不是最终独立验收，也不是Chrome实测。

# 已确认并交回owner

| 严重度 | 问题 | 修复责任 |
| --- | --- | --- |
| P0 | 旧WS异步响应使用全局socket，重连id重复导致串号 | A：捕获socket/代际 |
| P1 | persistQueue失败后永久reject，重载权威数据也不能再写 | A：健康写tail与加载栅栏 |
| P1 | tabs.create只有completed ledger，SW中断可重复创建 | A：pending意图与阶段持久化 |
| P0 | 断线移除onDetach/早退，用户取消可能丢失 | A：独立用户事件生命周期 |
| P1 | reconnect拿旧Chrome快照覆盖新的release/创建记录 | A：revision/代际检查 |
| P0 | Target.sendMessageToTarget内层message可绕显式命令校验 | B：managed拒绝该包装通道 |
| P1 | 控制请求cancel只停relay等待，不停extension后续步骤 | A/B：取消向extension透传 |

# 完整Chrome重启边界

审查提出needs-rebind缺少重绑入口。协调者判定：本轮约定为安全降级，
保留逻辑资源，不按URL/组名自动接管；不宣称完整Chrome重启自动恢复。
在没有显式用户验证的重绑设计前，不引入猜测式rebind接口。
SW重启（同browser epoch）和relay重启则是本轮必须恢复的验收项。

# 协调者跨端额外核验

- D工具返回的groupId/tabId/snapshotId/value必须进入content文本；
  仅放details会导致LLM看不到后续操作必需的资源ID。
- C worker startup超时要回收已spawn但未ready的进程，不能只settle请求。
- C worker流消息解析/大小错误不能作为uncaught反向杀掉relay。
- 已派原owner在各自worktree修订，上述表不能标为已解决直到read-back。

# 实测状态

集成树无Chrome：runtime build成功，249 tests通过；extension纯测试23通过。
Pi旧原型59 tests通过不是新工具验收。后续合入C/D后必须重新全链路检查。
