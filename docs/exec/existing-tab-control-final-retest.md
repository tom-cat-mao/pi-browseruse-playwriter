---
title: 原地接续定向复测（345ce12 / 修复 c37a0ba）
description: >-
  只复测"release 后重新 attach 同一物理 tab 能立刻操作且现场保持"：P1/P2 均
  PASS，重复 attach 幂等；hash 后退本轮未测（用户收窄范围）。
prompt: |
  用户授权最后定向复测，只做一项：release → 再次 discover/attach 同一物理 tab
  → 立即 evaluate/snapshot 成功，读到与 release 前相同的 draft/scroll/URL/
  window，并顺手验证同 session 重复 attach 返回相同 managed tabId。优先复用
  上一 run 的 session 与已拥有的测试源 tab，不新造组和标签；目标若被删除就
  报告，不猜别的页。随后用户明确收窄范围：不再启动任何 hash 相关测试/重试/
  诊断，hash 已有结果就记录、没有就标未测，不作为阻塞。一个小脚本、180s 内、
  每 API ≤10s，fixture try/finally 退出，不启停浏览器/runtime，不改产品不
  commit。
candidate: 345ce12（feat/existing-tab-control），实际修复 c37a0ba（getPage 明确
  等待 target 初始化事件），保留 a6cc285 的新 target 补发；extension 0.0.129；
  runtime 19991（PID 70627）token existing-tab-test
reference:
  - @docs/exec/existing-tab-control-live-retest.md
  - @docs/exec/existing-tab-control-plan.md
  - @tmp/existing-tab-retest-4e9cf95/out/ledger.json
  - @tmp/existing-tab-final-345ce12/out/verify.json
---

# 结论

| 项 | 结果 |
| --- | --- |
| 1. release → 重新 discover/attach 同一物理 tab → 立即操作且现场保持 | **PASS**（P1、P2 均通过） |
| 1b. 同 session 重复 attach 返回相同 managed tabId | **PASS**（P1、P2 均 `sameAsReattach=true`） |
| 2. hash anchor 点击 → page.back 去掉 hash | **未测**（用户收窄范围，本轮未执行；不作为阻塞） |

上一轮的两处问题：release/reattach 首动作失败（`resource-not-found: No open
Playwright page has targetId …`）**已由 c37a0ba 修复并真机验证通过**；hash
后退上一轮是**被扩展浮动工具栏遮挡而未验证**（非产品 FAIL），本轮按要求未测。

# 环境与物理目标

- runtime 19991 `existingTabControl:true`；P1 `12h9psg4abxxa`
  （epoch `epoch-mtvompvg-oirgjl1d5qujv`）、P2 `1sr6lelstfua1`
  （epoch `epoch-mtvoow87-1jr4mpebth4pq`）均 `connected`，epoch 未变。
- 复用上一 run 的 session `a5e6197a-c00d-4b34-a9cf-da2fd3a02897`。
- **物理 tab 已被替换**：ledger 里的 P1/1850783687、P2/1850783686 已不存在
  （discover 中消失）。两个 profile 各自只剩**唯一一个可连接的 linux.do 测试
  标签**，且仍在原窗口：
  - P1：chrome **1850783708**，window **1850783652**
  - P2：chrome **1850783706**，window **1850783679**
  - 同 URL、同窗口、同类型（用户指定的测试页），所以直接沿用，未碰任何其它页。
  （P1 还残留上一轮 popup 标签 1850783704，状态 `unsupported-page`，未操作。）

# 1) release → 重接，立即操作 + 现场保持（PASS）

流程：本机 fixture 导航 → 按 ref 填草稿 → 设滚动 → 读基线 → `tabs.release`
→ 重新 `tabs.discover` → `tabs.attach` 同一 candidate → **立刻**
`page.evaluate` + `page.snapshot`。

P1（chrome 1850783708 / window 1850783652）：

| | 值 |
| --- | --- |
| release 前基线 | `url=http://127.0.0.1:18777/read?tag=P1`, `draft="P1-复测草稿"`, `scrollY=600` |
| 重接后读回 | `url=http://127.0.0.1:18777/read?tag=P1`, `title="P1 阅读页"`, `draft="P1-复测草稿"`, `scrollY=600` |
| 重接后首个动作 | `page.evaluate` 成功（56ms）、`page.snapshot` 成功（2286 字符，拿到新 snapshotId） |
| managed tabId | `ptab-mtvriocg-1klnnko1vj58u5`（新 managed id，物理 chrome 1850783708 未变） |
| 重复 attach | 再次 attach 同一 candidate 返回 `ptab-mtvriocg-1klnnko1vj58u5`，**相同** |

P2（chrome 1850783706 / window 1850783679）：

| | 值 |
| --- | --- |
| release 前基线 | `url=…/read?tag=P2`, `draft="P2-复测草稿"`, `scrollY=450` |
| 重接后读回 | `url=…/read?tag=P2`, `title="P2 阅读页"`, `draft="P2-复测草稿"`, `scrollY=450` |
| 重接后首个动作 | `page.evaluate` 成功（61ms）、`page.snapshot` 成功（2286 字符） |
| managed tabId | `ptab-mtvrir4x-15pg5jdwi79xj` |
| 重复 attach | 返回同一 `ptab-mtvrir4x-15pg5jdwi79xj`，**相同** |

两次重接的 discover 都显示同一物理 tab：`managed=false owned=false
attachable=true`，windowId 与 URL 与 release 前一致；新 managed tabId 允许
不同（契约如此）。**没有新建/重开/移动窗口**——物理 chromeTabId 与 windowId
前后完全相同。

# 2) hash anchor（未测）

按用户收窄范围的指令，本轮未执行 hash 点击与 page.back，不重试、不诊断；
未测原因与上一轮"工具栏遮挡"结论一并保留在
`docs/exec/existing-tab-control-live-retest.md`，不作为阻塞项。（fixture 里
hash 控件已从顶部固定条移到正文下方以避开浮动工具栏，但本轮未验证。）

# 证据与收尾

- 新证据目录：`tmp/existing-tab-final-345ce12/`（git ignored）
  - 脚本 `verify.ts`（一个小脚本，复用 `tmp/existing-tab-retest-4e9cf95/lib/`）
  - `out/verify.log`、`out/verify.json`（全部读回数值与 tabId）
- 旧证据 `tmp/existing-tab-retest-4e9cf95/` 与旧报告均未改动、未被覆盖。
- fixture（127.0.0.1:18777）已 `try/finally` 关闭，监听与脚本进程无残留。
- 用户浏览器、runtime、标签与页面全部保留未动；未改产品文件、未 commit。
