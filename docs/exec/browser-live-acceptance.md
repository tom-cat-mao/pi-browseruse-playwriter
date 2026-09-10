---
title: Pi Browser Use 真机验收报告（候选 768998e）
description: >-
  用户授权的单轮真实 Chrome 验收：19990 测试 runtime + 仅连接的
  profile 12h9psg4abxxa，跑 acceptance-harness 主流程并定位 3 个 FAIL
  的根因（2 个为 harness 读取，1 个为 released 语义缺口）。
prompt: |
  来源：用户正式授权的 Chrome 真实验收执行指令（本次会话原文，节选）：
  "你是此次用户正式授权的Chrome真实验收执行者……环境已就绪：worktree
  feat/browser-acceptance-harness 刚由协调者 fast-forward 到冻结候选
  768998e……runtime 来自 integration/playwriter/bin-runtime.js，PID 2030，
  监听 127.0.0.1:19990，token acceptance-local-token；唯一 connected
  profileId=12h9psg4abxxa；日常 Chrome/19988 禁止触碰……仅运行核心实际
  使用链路……执行第一轮有意义的主流程：
  PI_BROWSER_ACCEPTANCE=1 node playwriter/scripts/acceptance/
  acceptance-harness.ts --run --base-url http://127.0.0.1:19990
  --token acceptance-local-token --profile 12h9psg4abxxa --fixture-server
  --non-interactive --cleanup never --report-dir
  $PWD/tmp/live-acceptance-768998e --json
  ……报告写本 worktree docs/exec/browser-live-acceptance.md……"
  candidate: 768998e
  运行命令与产物目录：tmp/live-acceptance-768998e/
  依据文件：@AGENTS.md @README.md @playwriter/src/skill.md
  @docs/exec/browser-runtime-contract.md
  @playwriter/scripts/acceptance/manual-acceptance.md
  @playwriter/scripts/acceptance/acceptance-harness.ts
  @playwriter/scripts/acceptance/acceptance-plan.ts
  @playwriter/scripts/acceptance/acceptance-client.ts
  @playwriter/scripts/acceptance/snapshot-refs.ts
  @playwriter/scripts/acceptance/fixture-server.ts
  @playwriter/scripts/acceptance/fixtures/group-page.html
  @pi/extensions/index.ts @playwriter/src/managed-executor-worker.ts
  @playwriter/src/managed-relay.ts @extension/src/resource-registry.ts
  @extension/src/managed-groups.ts
  运行时日志：integration/tmp/acceptance-runtime/relay-server.log 与
  cdp.jsonl
---

# 结论

run `e93b0af2`，候选 768998e，runtime 127.0.0.1:19990（PID 2030），
唯一 profile `12h9psg4abxxa`（epoch `epoch-mtvgnmb7-1cx7fxa1ng1x20`）。

PASS 18 / FAIL 3 / SKIP 4。3 个 FAIL 归为 2 个根因：

- 2 个 FAIL（page-navigate 的 marker 读取、fill-and-verify 的 value
  读取）是 **harness 读取代码用 bare expression**，产品语义按文档要求
  `return`；产品侧导航/fill 实际均成功。
- 1 个 FAIL（tab-release-semantics）是 **released tombstone 在
  relay/HTTP 层不可见**：`tabs.release` 后 tabs.list 不再含该 tab，
  后续 page 动作返回 `resource-not-found` 而非契约/harness 期望的
  `resource-released`。中优先级，待协调者决定归属（extension 发布
  inventory 时过滤了 released，relay 又整体替换缓存）。

4 个 SKIP 均为环境/授权边界：无第二 profile、无 Chrome-CDP 9333、
非交互未做 popup 目视、`--cleanup never` 未执行清理。

# 已真实跑通（harness 回包计数为准）

- preflight：capabilities 全 true；profile 显式解析（不猜）。
- 分组：同名组 3 个各自独立 groupId；groups.list 按 session 严格
  过滤；跨 session 操作拒绝（ownership-mismatch）。
- 标签：tabs.create 返回 ready + targetId + chromeTabId。
- page.navigate 请求成功（回包 url 一致）；page.screenshot 返回
  87215B PNG（3344x2044）并落盘 artifacts/（已 Read 目视：fixture
  页正确渲染，标题即 marker `acceptance:A1-e93b0af2`）。
- page.snapshot → aria-ref + snapshotId 的 click 通过，fixture 计数
  delta=1；stale snapshotId / 未知 ref 均被拒且无副作用。
- page.network start/list/stop 命中 fixture 请求恰好一次。
- 两类 popup（target=_blank 与 window.open）都进入源 group：实测
  两个独立弹窗 tab 均在 group pgrp-mtvj4nqy-1qn7bgg6bx0kq
  （1850783610 / 1850783611；relay 日志 "Adopted inherited tab
  1850783611 into managed group pgrp-mtvj4nqy…"）。
- session.release 保留组/标签并可继续操作；request.cancel 不重放
  （fixture 计数 delta 0 且稳定）。

# 发现（按影响基本可用性排序）

## R1 [中] tabs.release 后 released tombstone 在 API 不可见

- 现象：release 回包 ok；随后 session B tabs.list 只剩 B1，B2 记录
  完全消失（harness 期望 `state: released`）；对已 release 的
  ptab-mtvj4oal-1oieldchuboug 做 page.snapshot 返回
  `resource-not-found`（期望 `resource-released`）。
- 精确触发（一次）：`tabs.release` 任一 managed tab 后立刻
  `tabs.list` / page 动作。
- 根因：extension/src/resource-registry.ts:606-615
  `buildInventory()` 过滤 `state === 'released'` 的 tabs 与 groups；
  本地 tombstone 仍保留（releaseTab，resource-registry.ts:416），但
  relay 用 inventory 整体替换缓存（playwriter/src/managed-relay.ts:1174
  `new Map(inventory.tabs…)`），relay 侧记录随之消失；relay 的
  released 分支（managed-relay.ts:2930）无法命中。
- 建议 owner：协调者决定由 A（extension 在 inventory 中发布 released
  记录）或 B（relay 合并保留上一版 released tombstone）小修；若产品
  有意让 released 对 agent 不可见，则需同步改 harness 期望与
  manual-acceptance.md Step 6 的 `resource-released` 描述。

## H1 [harness，非产品] page.evaluate 读取用 bare expression 导致 2 个假 FAIL

- 现象：page-navigate 报 marker ""、fill-and-verify 报 input value ""。
- 实际产品行为正确：CDP 日志有且仅有一次
  `Input.insertText "acceptance-value-e93b0af2"`（cdp.jsonl:442），
  截图目视 marker 正常；对同一 tab 用带 `return` 的 page.evaluate
  实测返回 `{marker:"acceptance:A1-e93b0af2",
  nameValue:"acceptance-value-e93b0af2"}`（tmp/live-acceptance-
  768998e/min-repro-eval-a1.json）。
- 根因：harness 的 evaluate 代码是裸表达式（acceptance-harness.ts
  约 966/1080/1100 行），而产品把 page.evaluate 包成
  `(async () => { code })()` 且不自动 return
  （managed-executor-worker.ts:1208），Pi 工具说明也明确
  "End with `return <value>` — a bare expression returns undefined"
  （pi/extensions/index.ts:689）。
- 建议 owner：acceptance 侧在 3 处 code 前加 `return `；不要改产品。
  同理，stale-snapshot/unknown-ref 里的 "input unchanged" 断言因同一
  读取方式不构成有效证据（其余拒绝码断言有效）。

## H2 [harness 证据瑕疵，低] popup-window-open 记账复用第一个 popup 的 tabId

- ledger 中两个 popup 步骤记录同一 tabId ptab-mtvj4qp5-r4bw2mpvd723；
  实测 window.open 弹窗是另一独立 tab
  ptab-mtvj4r58-otf5l7czkibz（1850783611，已入源组）。产品行为正确，
  建议后续修正 harness 的 popup 定位/记账。

## 备注（低）

- extension 日志反复出现
  `Failed to apply Page.setDownloadBehavior … "Cannot not access
  browser-level commands"`（relay-server.log，worker 连接时），本 run
  未见功能影响，留作后续清理项。

# 未测 / 人工项

- 第二 profile 与跨 profile 隔离：SKIP（未连接第二 profile）。
- Chrome-CDP（9333）真实 targetId 交叉校验：SKIP（未提供端点）。
- popup 目视确认（用户人工）：SKIP，非交互模式，未伪造确认。
- 手动故障 phases（拖出/relay restart/sw restart/extension reload/
  worker kill）：本轮未跑，需第二授权与人工操作。
- page.logs 独立断言：fill 步骤在读取处中断，未跑到；browser_logs
  工具路径未验证。page.execute（Node/Playwright）未验证。
- Pi 工具层 content（snapshotId/tabId 可见性）轻量真实 HTTP 验证：
  未做——本 worktree Pi 包 peer 依赖未安装，加载 factory 需安装
  依赖或自造 stub，按约束跳过。本轮不等于 Pi 交互端全链路。

# 证据与资源

- 报告/ledger/stdout/PNG/min-repro：
  tmp/live-acceptance-768998e/{report,ledger}-e93b0af2.json、
  stdout.log、artifacts/screenshot-e93b0af2.png、
  min-repro-eval-a1.json、min-repro-released-snapshot.json
- 运行时日志：integration/tmp/acceptance-runtime/{relay-server.log,
  cdp.jsonl}
- 本 run 创建资源（runId e93b0af2，session A
  cd6e93f3-b743-4ef0-a912-9c7d0ca558c8，session B
  65795f67-77e0-4e3a-bf57-e9c358f3248f）：
  groups pgrp-mtvj4nqy-1qn7bgg6bx0kq、pgrp-mtvj4nr2-1xjjnvm5wnpum、
  pgrp-mtvj4nr5-rji67i7alggr；tabs ptab-mtvj4nr9-lawbmg1o3f9ex、
  ptab-mtvj4nyi-10vlxpx1xwhnrf、ptab-mtvj4o24-1bu4bzzq2fe2s、
  ptab-mtvj4oal-1oieldchuboug（已 released）、
  ptab-mtvj4qp5-r4bw2mpvd723、ptab-mtvj4r58-otf5l7czkibz
- 后续安全清理（本 run 自己的分组/标签；需人工确认后执行）：
  PI_BROWSER_ACCEPTANCE=1 node playwriter/scripts/acceptance/
  acceptance-harness.ts --cleanup-only --base-url http://127.0.0.1:19990
  --token acceptance-local-token --state
  tmp/live-acceptance-768998e/ledger-e93b0af2.json
- 清理状态：harness 与 fixture server（127.0.0.1:58893）已自行退出，
  无残留进程；用户 runtime（PID 2030，含其 worker 子进程）与 Chrome
  保留；未 commit / push / 改产品代码。
