---
title: 现有标签控制真机验收（a6ef8ba，未完成，等待用户开空白页）
description: >-
  两个指定测试 Chrome profile 的真机验收：发现元数据可用但两 profile 均无
  attachable 空白页，原地接续五项主场景未执行；普通新任务建组回归暴露"一
  session 只认第一个 tab"的阻塞问题。
prompt: |
  用户授权本轮只测执行计划的五个实际场景（多 profile/window 元数据、原地
  控制保持现场、外链继续阅读、原 tab 内导航 back、非视觉路径与归属），
  只走 19991 managed HTTP，不启动/关闭浏览器，不碰 Pi 配置或 profile 磁盘。
  P1=12h9psg4abxxa / P2=1sr6lelstfua1，第三 profile 1my7iz3tylzbt 不操作。
  无可用空白页时必须立即回报让用户各开 about:blank，不用 managed
  tabs.create 绕过 existing 主场景。发现链路 blocker 即停止并分类，
  不抬高门槛；脚本错误不算产品问题。产出简短中文报告，真实 PASS/FAIL/SKIP。
candidate: a6ef8ba（feat/existing-tab-control，extension 0.0.129，
  forkID eeklahpecooapnailfaebkjjembkjhhg，runtime 19991，token existing-tab-test）
reference:
  - @docs/exec/existing-tab-control-plan.md
  - @playwriter/src/browser-protocol.ts
  - @playwriter/src/skill.md
  - @pi/skills/SKILL.md
  - @playwriter/scripts/acceptance/acceptance-client.ts
  - @tmp/existing-tab-live-a6ef8ba/out/ledger.json
---

# 结论（一句话）

**五项主场景全部未执行（SKIP）**：两个测试 profile 目前都只有 1 个 window /
1 个 `chrome://newtab/`，runtime 标记 `attachable=false reason=restricted-url`，
没有任何可原地接入的空白或 fixture 页。已停在此处等用户各开一个 `about:blank`。
另外普通新任务建组回归里发现一个疑似产品 blocker（见根因 1）。

# 场景结果

| # | 场景 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | 多 profile/window 元数据 | 元数据 PASS / 原地 attach SKIP | 两个 profile 的 windowId、title、url、active、windowFocused、attachable 都有值；**实际每个 profile 只有 1 个 window、1 个 tab**（未伪称多 window）。唯一 tab 是 `chrome://newtab/`，不可接入，原地 attach 未执行。 |
| 2 | 原地控制保持现场（release→重接） | SKIP | 依赖场景 1 的可接入 tab。 |
| 3 | 外链新标签往返 | SKIP | 同上；另受根因 1 直接影响（需同一 session 读新 tab）。 |
| 4 | 原 tab 内导航 + back | SKIP | 同上。 |
| 5 | 非视觉路径 + 归属 | 部分 PASS | 文本 DOM/AX refs 路径可用：snapshot 文本含页面标题、`page.fill` 按 ref 成功（回归 tab）。其它 session 访问他人的 tab 返回 `ownership-mismatch`（正确，不抢占）。第二 session attach 已被控制的 tab 未跑到（无 attach 目标）。 |

普通新任务建组小回归（只允许 1 次）：`groups.create` / `tabs.create` /
`page.snapshot` / 按 ref 的 `page.fill` 成功；同 session **后续**新建的 tab
执行任何 `page.*` 失败（根因 1）。

# 三个根因（按影响排序）

1. **一个 session 的 executor 只认它控制的第一个 tab（产品 blocker，阻塞场景 3）**
   同一 session 里第 2、3 个新建 tab 执行 `page.evaluate` 全部返回
   `resource-not-found: No open Playwright page has targetId <targetId>`；
   该 session 的第一个 tab（chrome 1850783691）始终可用，换一个全新 session
   后它自己创建的第一个 tab 也可用。尚未验证是否同时影响 attach 与新开外链
   tab（因缺可接入页未能进主场景）。修复方向由协调者定位；我未深入 worker 内部。
2. **测试环境无可接入页（非产品问题，需用户操作）**
   P1/P2 各 1 window / 1 tab = `chrome://newtab/`（restricted-url）。
   请用户在两个 profile 各开一个标签，地址栏输入 `about:blank` 回车后保持打开。
3. **（脚本问题，不算产品问题）** fill 之后快照即失效，`page.click` 复用旧
   `snapshotId` 会得到 `stale-snapshot`；每个动作前需重新 `page.snapshot`。

# 已验证 / 未验证

- 已验证：capabilities `existingTabControl:true`、三 profile 已连接；
  `tabs.discover` 元数据字段完整（含 `windowFocused=false`，用户切回终端后
  确实无焦点）；跨 session 抢占被正确拒绝；文本快照 + ref 可完成填写。
- 未验证：原地接续、外链往返、back、release 后重接、第二 session attach
  的 ownership-mismatch——全部受上面两个原因阻塞。

# 需要用户操作（明确停在这里）

在 P1、P2 两个测试 Chrome 里各开一个标签，地址栏输入 `about:blank` 回车，
保持打开，然后我即可继续剩下的四项；不需要用户做别的准备。

# Artifact / ledger

- 目录：`tmp/existing-tab-live-a6ef8ba/`（git ignored）
- 日志与结果：`out/01-discover.log`、`out/01b-discover-include-managed.log`、
  `out/01-discover.json`、`out/02-managed-regression.log`、`out/03-diag-worker.log`
- 资源 ledger：`tmp/existing-tab-live-a6ef8ba/out/ledger.json`（session /
  group / tab / chromeTabId / 来源关系；仅 P1 内资源）
- 脚本：`01-discover.ts`、`01b-...`、`02-managed-regression.ts`、`03-diag-worker.ts`、
  `lib/runtime.ts`、`lib/fixture.ts`（fixture 监听 127.0.0.1:18777，已退出，端口已释放）
- runtime 日志（用户启动的进程）：`tmp/test-runtime/relay-server.log`

# 收尾状态

我的 fixture 进程与脚本已全部退出，端口 18777 已释放；没有关闭任何用户
浏览器窗口或标签，没有动 runtime/Pi 配置。本轮为验收目的在 P1 创建的
分组与标签（见 ledger）保留供观察，未关闭。产品文件未改动，未 commit。
