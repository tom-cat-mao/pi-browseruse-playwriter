---
title: 现有标签控制真机复测（4e9cf95 / 修复 a6cc285）
description: >-
  两个真实测试 profile 的原地接续复测：发现/attach/外链往返/普通后退/归属拒绝
  通过；release 后重新 attach 的标签首动作失败（产品问题，待修）；hash 后退
  因测试链接被扩展浮动工具栏遮挡而未验证（非产品问题）。
prompt: |
  用户已备好两测试 Chrome（各一个 linux.do 标签，明确供测试用），授权续测执行
  计划五项：两 profile/window 元数据与正确 attach、原页 draft/scroll 保持、
  target=_blank 与 window.open popup 的来源继承/读取并 activate 回源、普通
  history back 与一次 hash back、纯文本 AX 操作与另一 session 的冲突拒绝。
  只走 19991 managed HTTP，不启动/关闭浏览器，不碰第三 Chromium profile 与
  19988/19989/19990。有界发现一次即跑核心动作；核心步骤 FAIL 只做一次最小复现
  + 准确 body/log 就停下报告，不审 worker 内部、不造诊断堆积、不为绿跳步骤。
  新产物在 tmp/existing-tab-retest-4e9cf95/，旧报告与证据不动。
candidate: 4e9cf95（feat/existing-tab-control），产品修复 a6cc285（managed client
  收到 inventory 后补发之前 scope 丢掉的真实 attached 事件，同 owner 一次去重），
  extension 0.0.129，runtime 19991 token existing-tab-test
reference:
  - @docs/exec/existing-tab-control-plan.md
  - @docs/exec/existing-tab-control-live-acceptance.md
  - @playwriter/src/browser-protocol.ts
  - @tmp/existing-tab-retest-4e9cf95/out/ledger.json
---

# 总览

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 两 profile/window 元数据 + 正确 attach | **PASS** |
| 2 | 原地保持现场（release→重接同一物理 tab） | **FAIL**（重接后首个动作失败；物理身份与 URL/window 均在。根因待修，见下） |
| 3 | 外链 target=_blank + popup 来源继承/读取 + activate 回源 | **PASS** |
| 4a | 原 tab 内普通导航 → 真 history back | **PASS**（draft/scroll 均恢复） |
| 4b | 一次 hash back | **BLOCKED / 未验证**（测试链接被扩展浮动 toolbar 遮挡，非 hash/history 功能问题） |
| 5 | 纯文本 AX 路径 + 另一 session 的 attach 冲突拒绝 | **PASS**（同 session 重复 attach 幂等未跑到，SKIP） |

真实环境：**2 profile / 2 window**（P1 window 1850783652，P2 window 1850783679），
没有多余窗口，未向用户索要更多。

# 场景 1：元数据与原地 attach（PASS）

`tabs.discover` 元数据齐全且真实：`active=true`，P1 `windowFocused=false`、
P2 `windowFocused=true`（用户切到 P2 后焦点在那里），`attachable=true`。

全新 session 直接 `tabs.attach`（未先建组）：

- P1 → `tabId=ptab-mtvqaj4p-19a7qdx5z202x`，`chromeTabId=1850783687`（=发现值），
  `profileId=12h9psg4abxxa`，`origin=existing`，内部组自动建立。
- P2 → `tabId=ptab-mtvqfz8d-v9v5cw1gcbs7v`，`chromeTabId=1850783686`，
  `profileId=1sr6lelstfua1`，`origin=existing`。

attach 后立刻用纯文本快照读真实页正文：linux.do 快照 24125 / 24259 字符，
含 `Skip navigation links`、`Sidebar` 等真实节点；未注册/发帖/点赞/读 cookie。

# 场景 2：现场保持（FAIL，产品问题待修）

已通过的部分：attach → 导航本地 fixture → 按 ref 填草稿 → 滚动 → release →
**重新 discover 到同一个物理 tab**（chromeTabId 不变、windowId 不变、URL 为
刚导航的地址、`managed=false owned=false`）→ **再次 attach 返回同一
chromeTabId 的新 tabId**（`origin=existing`，新 managed id 允许）。

失败点：重接后的**第一个动作**就失败，两个 profile 各复现一次：

```
[resource-not-found] No open Playwright page has targetId 067F1707B9D095BD1164EB6000AF9FE6   (P1)
[resource-not-found] No open Playwright page has targetId 1F256DEC5773391446407845150231FE   (P2)
```

现状与定位（**待修，未解决**）：该问题已交 Codex22 处理，当前判断是
**竞态**——relay 已经补发了 attached 事件，但 worker 侧 Page 初始化尚未完成，
同步 `getPage` 调用过早而失败；**不是"事件没发出去"**。本轮只做到记录现象与
日志证据，未继续审 worker 内部，也**不声称已修复**。
日志证据（`tmp/test-runtime/relay-server.log:6528-6540`，P2 例）：release 时
`Target.detachedFromTarget` 已转发；重接时 managed client 也收到了
`Target.attachedToTarget ... (server-generated)`（同 targetId、新 sessionId
`pw-tab-…-2`），但 executor 仍返回找不到该 page。

影响：用户"先放手再重新接着做"会拿到一个不可操作的 tab；数值层面
draft/scroll 是否在重接后保持，因无法执行动作而**未验证**（不是"变了"，
是读不到）。同一 session 内未 release 时，draft `P1-外链测试草稿` 与
`scrollY=600` 在 activate 往返与后退后均保持（见场景 3/4a）。

# 场景 3：外链往返（PASS）

在同一 P1 源 tab（`ptab-mtvqaj4p…`）上：

- 点普通 `target=_blank` 链接：新 tab `ptab-mtvqajrq-1kra1hz1sn6g94`
  （chrome 1850783703，window **1850783652** = 原窗口），
  `sourceTabId=ptab-mtvqaj4p…`，`origin=existing`；快照读到
  `- heading "P1 外链目标页"`。新 tab 用**前后 tabId 差集 + sourceTabId** 定位，
  不是猜最后一个或按 URL。
- 点 `window.open(..., 'width=520,height=420')` popup：新 tab
  `ptab-mtvaprk-g0yp1e1oh2xu0`（chrome 1850783704，window 1850783705），
  `sourceTabId` 同样正确，快照读到 `- heading "P1 popup窗口页"`。
  → **popup 可被 attach 并读取**，上游"可能不行"的猜测被证伪；popup 以独立
  window 形式存在（window.open 带 features 的原生行为），**源 tab 仍在原
  window 1850783652 未被移动、未被关闭**。
- `tabs.activate` 回源 tab：读回 `url=/read?tag=P1`、
  `draft="P1-外链测试草稿"`、`scrollY=600` —— 原位置与原输入都在。

# 场景 4：后退

- **4a 普通 history back（PASS）**：点同标签链接跳到 `/next?tag=P1` 后
  `page.back` 返回 `text="Went back to http://127.0.0.1:18777/read?tag=P1"`、
  `value={url, title, hadNavigationResponse:true}`（不是 null=失败，也不是
  goto 旧 URL）；读回 `url=/read?tag=P1`、`draft="P1-外链测试草稿"`、
  `scrollY=600` —— **URL、草稿、滚动都恢复**。
- **4b hash back（BLOCKED / 未验证）**：hash 链接**点不中**，不是 hash 或
  history 功能问题。协调者核对 `tmp/test-runtime/cdp.jsonl`（第 1792、1815、
  1841、1859… 行）确认：Playwright 的命中检查在 hash-link 的 bbox
  `x 295.9..351.9 / y 9.5..28.5` 上返回的是
  `<div data-playwriter-toolbar="1"></div>`，即扩展浮动工具栏盖住了该链接；
  日志里始终没有该链接的 `Input.dispatchMouseEvent`，25s 后 deadline 取消，
  因此表现为 `[cancelled] … worker was terminated`。
  结论：**hash 后退能力本轮未被验证**，不能记为产品 FAIL。
- 脚本侧错误（我方，已记录）：我当时把 `cancelled` 直接当成"动作未开始"并
  自动重放了点击。按契约只有 `error.outcome === 'not-started'` 才能这样判断，
  `unknown` 禁止自动重放；本轮实际重放了多次，如实记为脚本问题。正式复测时
  必须先用页面上的 **Hide toolbar** 按钮隐藏工具栏，或调整本地 fixture 布局
  避开 overlay；不允许 force click、不允许用 evaluate 直接触发点击，
  也不允许靠加大 timeout 绕过。

# 场景 5：非视觉路径与归属（PASS）

- 全部操作走纯文本 AX 快照 + `data.value.refs` 的 ref（`@eN` + 本次
  `data.snapshotId`，每次动作前重新 snapshot），未用任何截图/视觉模型。
- 另一 session attach 已被本 session 控制的 tab：
  `[ownership-mismatch] tab ptab-mtvqaj4p-19a7qdx5z202x is already controlled
  by another session` —— 不抢占（另一次对上一轮 session 的 tab 也是同样拒绝）。
- 同 session 重复 attach 幂等复用：**SKIP**（排在场景 2 重接之后，因该步骤
  失败未跑到，本轮未重跑，待 runtime 修完再验）。

# 根因与状态

1. **release → 重新 attach 的 tab 首个动作失败（产品问题，待修）**：
   `No open Playwright page has targetId <id>`，两 profile 各复现一次。
   根因判断为**竞态**（relay 已补发 attached，worker Page 初始化未完成，
   同步 `getPage` 过早失败），已交 **Codex22** 处理；**尚未修复，需等 runtime
   修完再复测**，本报告不声称已解决。
2. **hash back 未验证（测试环境问题，非产品 FAIL）**：hash 链接被扩展浮动
   工具栏遮挡（cdp.jsonl 1792/1815/1841/1859…，命中检查返回
   `data-playwriter-toolbar`，bbox x295.9..351.9 y9.5..28.5，无
   `Input.dispatchMouseEvent`，25s deadline 取消）。复测时用 **Hide toolbar**
   或调整 fixture 布局规避，禁止 force/evaluate 点击与加大 timeout。
3. **脚本侧问题（不算产品问题）**：① 我把 `cancelled` 当成"动作未开始"并自动
   重放了点击，只有 `outcome==='not-started'` 才可这样判断，`unknown` 禁止自动
   重放；本轮实际重放多次，已在脚本中去掉该自动 retry。② `page.fill` 之后快照
   失效，每次动作前需重新 `page.snapshot`。

# Artifact / ledger

- 新目录 `tmp/existing-tab-retest-4e9cf95/`（git ignored）：
  `01-discover.ts`、`02-inplace.ts`、`03-links-back-ownership.ts`、
  `04-hash-ownership-p2.ts`、`lib/runtime.ts`、`lib/fixture.ts`
- 日志与结果：`out/01-discover.log|json`、`out/02-inplace.log`、
  `out/03-links-back-ownership.log|json`、`out/04-hash-ownership-p2.log|json`
- **ledger：本 worktree `tmp/existing-tab-retest-4e9cf95/out/ledger.json`**
  （session / group / tab / 物理 chromeTabId / windowId / sourceTabId / 实测
  draft 与 scroll 数值来源）。同内容在本轮曾被误写到主目录
  `/Users/bytedance/pi/pi-browseruse-playwriter/tmp/existing-tab-retest-4e9cf95/out/ledger.json`，
  该副本按原样保留，以 worktree 内这份为准。
- runtime 日志（用户进程）：`tmp/test-runtime/relay-server.log`
- 旧报告 `docs/exec/existing-tab-control-live-acceptance.md` 与旧证据未改动。

# 收尾状态

fixture（127.0.0.1:18777）监听已关闭，我的脚本进程已退出；未启动/关闭任何
Chrome、runtime 或用户标签，未改 Pi 配置与产品文件，未 commit。本轮 attach 的
标签与新开的两个子标签**保留供用户查看**（P1 源 tab 与两个子 tab、P2 的两个
tab 记录）。端口上残留的是 Chrome 自己的 network service 连接，未杀。
