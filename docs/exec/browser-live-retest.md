---
title: Pi Browser Use 真机复验报告（候选 6aeb91c）
description: >-
  修复集成后的第二轮真实 Chrome 验收：19990 runtime + profile
  12h9psg4abxxa（0.0.127 扩展），主流程全绿，H1/H2/R1 三个旧根因
  全部闭环。
prompt: |
  来源：用户授权复验指令（本次会话原文，节选）：
  "用户已明确完成重载0.0.127……现授权你再跑一轮核心真机验收……只复验
  已发现问题+原主流程……本轮必须全新session A/B与runId，不复用旧run
  e93b0af2的任何tab/group/ledger或needs-rebind资源……先GET指定profile
  继续connected后从当前cwd执行（整体timeout300s……）：
  PI_BROWSER_ACCEPTANCE=1 node playwriter/scripts/acceptance/
  acceptance-harness.ts --run --base-url http://127.0.0.1:19990
  --token acceptance-local-token --profile 12h9psg4abxxa --fixture-server
  --non-interactive --cleanup never --report-dir
  $PWD/tmp/live-retest-6aeb91c --json……
  新报告docs/exec/browser-live-retest.md，frontmatter含candidate6aeb91c/
  source/实际run；原first-report不修改。"
  candidate: 6aeb91c（H1/H2 修复 983bd1c 与 R1 修复 3e638d1 均已集成）
  run: 0546d44d，2026-09-10，runtime 127.0.0.1:19990（用户 PID 2030）
  依据文件：@docs/exec/browser-live-acceptance.md（第一轮原始报告）
  @playwriter/scripts/acceptance/acceptance-harness.ts
  @playwriter/scripts/acceptance/acceptance-plan.ts
  @playwriter/scripts/acceptance/manual-acceptance.md
---

# 结果

PASS 22 / FAIL 0 / SKIP 4（exit 0）。主流程全绿，旧三个根因全部闭环。

preflight：capabilities 全 true；profile `12h9psg4abxxa` 显式选择，
新 epoch `epoch-mtvjt0pc-6zkqn519ak41o`。

# 旧根因闭环

- **H1（evaluate 读取）已闭环**：page-navigate `PASS`（marker 实读
  `acceptance:A1-0546d44d`）；fill-and-verify `PASS`（fill 经 DOM
  校验、click 产出 echo+日志、counter delta 恰好 1，说明 page.logs
  断言真实走完）；unknown-ref 的 before/after 读取现在有效（
  "input unchanged" 基于真实值）。
- **H2（popup 记账）已闭环**：两个 popup 记录不同 tabId
  （`ptab-mtvjvyf6-1yt1i1w1odb4ec` 与
  `ptab-mtvjvz07-13gu0hhadoi3z`），均在源组
  `pgrp-mtvjvvph-i4dbxx1xpfrvt`，harness 证据显式标注 distinct。
- **R1（released 语义）已闭环**：tab-release-semantics `PASS` —
  release 后 tabs.list 可见 `state: released`，页面动作被拒
  `resource-released`，组保留。
- **新增 page.execute**：`return await page.title()` 返回
  "Acceptance Group Page"，`PASS`（成功值验收，非仅 cancel 路径）。

# SKIP（明确不算 pass，未扩大范围）

- multi-profile：仅一个 profile 连接，未跑。
- cdp-target-crosscheck：未提供 Chrome-CDP 端点。
- popup-visual：非交互会话，未做人工目视确认（用户可自行看本轮弹窗）。
- cleanup-own-only：`--cleanup never`，资源保留供观察。

# 证据与本轮资源

- 报告/ledger/stdout/PNG：
  tmp/live-retest-6aeb91c/{report,ledger}-0546d44d.json、stdout.log、
  artifacts/screenshot-0546d44d.png（已目视：fixture 正常，
  marker=A1-0546d44d）。
- 全新 sessions：A `b0642476-7450-4595-a4f3-5a4b0e7f6fae`，B
  `44b306d9-8e31-4c9e-9254-c1d380475e68`；未复用旧 run e93b0af2 任何
  资源。
- 新建 groups：pgrp-mtvjvvph-i4dbxx1xpfrvt、pgrp-mtvjvvpl-1j9y94sd2y2kp、
  pgrp-mtvjvvpo-1n1d0gzjh16tt；tabs：ptab-mtvjvvpv-nq839l2ska2f、
  ptab-mtvjvvsw-rxw7yq1hcblta、ptab-mtvjvvww-1m7zw7ye57lfz、
  ptab-mtvjvw1u-buh195fp7wgw（已 released）、
  ptab-mtvjvyf6-1yt1i1w1odb4ec、ptab-mtvjvz07-13gu0hhadoi3z。
- 后续安全清理（需人工确认后执行；本轮未执行）：
  PI_BROWSER_ACCEPTANCE=1 node playwriter/scripts/acceptance/
  acceptance-harness.ts --cleanup-only --base-url http://127.0.0.1:19990
  --token acceptance-local-token --state
  tmp/live-retest-6aeb91c/ledger-0546d44d.json

# 清理状态

harness 与 fixture server（127.0.0.1:60860）已自行退出；该端口无
LISTEN 残留（仅 Chrome 侧 CLOSE_WAIT 客户端套接字，随页面释放）；
无 harness/fixture 进程。用户 runtime（PID 2030）与 Chrome 保留。未
改产品代码、未 commit、未 push。
