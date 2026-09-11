---
title: Browser 可靠性修复交付记录
description: 汇总 swarm 实现、独立检查、真实 Chrome 首轮失败与定点修复复验。
prompt: |
  用户要求多个默认配置的 codex/traex/codebuddy 在独立工作树并行修复，
  修改仓库 AGENTS.md，独立验收并配合 Chrome 测试；最终只合开发分支 dev，
  不合 main，也不更新正在使用的 Pi/runtime/扩展。
  根据 @docs/exec/browser-reliability-plan.md
  @docs/exec/browser-reliability-review.md
  @docs/exec/browser-reliability-acceptance.md
  @docs/exec/browser-reliability-live-acceptance.md
  @docs/exec/browser-reliability-live-retest.md
  @playwriter/src/browser-protocol.ts @extension/manifest.json
  @AGENTS.md @pi/skills/SKILL.md 与各阶段实际提交/检查记录汇总。
---

# 交付边界

- 基线：`dfedbdc`；开发集成：`feat/browser-reliability`；PR base：`dev`。
- 最后真实测试代码：`cffbeea`；报告合入：`b3490de`，未再变更产品源码。
- main、当前 Pi 设置/安装、默认 19989 runtime 与日常 legacy 19988 均不更新。
- 不发布 npm、Chrome Web Store、GitHub Release；不推送 extension 标签。
- 扩展版本 0.0.131，测试包使用独立 19992；用户已准备的 Chrome profile 不关闭。

# 实现

| 流 | 完成内容 |
| --- | --- |
| runtime | 有界长驻抓包缓冲，worker 强制取消/超时不丢既有证据；stop 可继续查询；start 原子替换与 stop fencing；timeout/cancel 区分 |
| executor | 严格 scope 短等待，正文与 refs 同窗/双预算，summary DOM/Shadow 宿主定位，剩余 request deadline，真实 pageInfo |
| extension | 活动标签优先发现，URL/title 内存更新合并发布 inventory |
| Pi | 人类摘要/完整错误展开、ANSI 清理、真实值/捕获数、按 session 页面上下文、discover 分页与 HTTP 响应宽限 |
| guidance | 直接维护本仓库 AGENTS.md，删除失效生成命令，旧 PLAYWRITER_AGENTS.md 留兼容指针 |

# 验收证据

1. 独立源码阶段发现 R1/R2/R3（replacement start 丢证据、stop 后再激活、
   shutdown 清全会话缓存）；修复后独立复核全部关闭。
2. 全新 agent 的浏览器无关候选 `67cf33b` 验收：runtime unit **260**、
   process integration **34**、extension **43**、Pi **93**，另 **98** 项真实
   函数/序列化探针与 typecheck/build/smoke/load-check 全部通过。
3. 真 Chrome 首轮：Pi 工厂 → 真实 client → 19992 → 已加载扩展 → Chrome，
   **83 PASS / 2 FAIL / 0 SKIP**。原始 FAIL 报告保留，不改写为成功。
4. 两项真实缺陷定点修复：F1 用 CDP host.shadowRoots 元数据补齐宿主链、
   禁止不完整 selector；F2 两条取消入口保留 deadline 原因。协调者复跑
   相关 **82** 项测试通过，包含真实子进程 pool 经 HTTP relay 的新回归。
5. 原测试 agent 真 Chrome 窄重测 `cffbeea`：**27/27 PASS**。Shadow summary
   实际 ref 点击仅切换目标；timeout 与 cancelled 正确区分；同 captureId、
   POST200 证据保留、计数不重放、新 worker 可读。没有重跑无关矩阵。

# 已知边界

- 物理 Pi 终端字体/屏幕未测，UI 使用真实 renderCall/renderResult 程序化验证。
- 原 Linux.do 特定历史 back 挂起未复现，不能宣称该特定根因已解决；本地
  SPA/history back、draft/scroll 及 deadline 反馈已验证。
- 145 候选分页用数据/真实 shaper 验证；未创建 145 个浏览器标签。
- 没有再次发帖、真实站点提交、hash 专项或额外安全/性能/平台矩阵。
- 抓包只在当前长驻 runtime 内存保留，不提供 runtime 重启后的落盘恢复。
- 任意 evaluate/execute 后引用仍保守失效；href/control-state 扩展未纳入。

# 收尾规则

只通过 fork PR 合入 dev，main 保持基线。保留提交历史、独立报告和原始证据。
删除工作树前先归档 ignored harness/logs/builds；仍被 Chrome 引用的测试扩展
路径保留兼容位置。测试 runtime 19992 已停止，不能为清理误杀其他服务。
