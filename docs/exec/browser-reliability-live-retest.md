---
title: Browser 可靠性 F1/F2 修复窄验收（cffbeea，真实 Chrome retest）
description: 在相同 prepared Chrome/19992 上仅重测 F1 open-shadow summary ref 与 F2 deadline 归类；27/27 PASS，原 FAIL 报告保持不变。
prompt: |
  用户授权：接收 source 提交 2e6ee23（F1）与 a781042（F2）cherry-pick 进 acceptance worktree 后，
  仅重测 F1/F2 及直接相关回归；使用相同 Chrome profile 18trj91a7isot / 已加载扩展 0.0.131 / 19992，
  不 reload/rebuild 扩展、不触碰 19989；新证据只写 tmp/live-retest-cffbeea；只提交本报告
  （docs/exec/browser-reliability-live-acceptance.md 原 FAIL 文档不改）；不推送/PR/合并/tag；
  物理 Pi 终端字体仍未测。依据 @AGENTS.md @docs/exec/browser-reliability-live-acceptance.md。
---

# 结论：PASS（27/27）

窄重测全部通过，两个原始缺陷独立 disposition：

- **F1 PASS**：open shadow root 内 `<summary>` 现在产出**可执行且指向正确**的 ref；按 ref 点击成功
  （无 strict-mode violation），只切换 shadow details，light DOM 三个 details（含隐藏 sibling）保持
  不变；fresh snapshot 后 light 第一/第二 summary 仍各自正确点击。
- **F2 PASS**：真实 `browser_execute`（timeout=1000ms、pending 6s）返回
  `Managed executor request timed out; worker was terminated · code=timeout · outcome=unknown`
  （1007ms，不再报 cancelled、无 raw abort）；既有 capture 保持**同一 captureId**
  `6bbd10d9-5200-462f-af60-361d910b6757` 与 POST200 条目，计数器不重放；显式用户
  `request.cancel` 仍为 `code=cancelled/outcome=unknown` 且证据保留；随后的真实 worker 读取正常。

只重测 F1/F2 与直接相关回归；原 85 项矩阵、145 标签、hash/真实站点场景均未重跑（按要求）。

# 候选与来源

- 收到并 cherry-pick 至本分支 `swarm/reliability-acceptance`：
  `2e6ee232d1ccfa0db44ec7f30303aea00df5517f` → `dfc0cc0…`（F1），
  `a781042f5c61f146bfe7ab88f90255137afc33bc` → `27aa5a2…`（F2）；无冲突。
- 与集成分支逐一核对：`git diff --stat cffbeea HEAD` **空**（工作树与集成分支 `cffbeea`
  完全同树，仅历史/文档提交不同）；`2e6ee23` 与 `630a3e0`、`a781042`（独立部分）与 `cffbeea`
  内容一致。
- 实测运行源码 blob：`aria-snapshot.ts cd62f92bc6b410cc3e759720b9bbb39491e98fec`、
  `managed-relay.ts f64140879ee5948406ce2346f00af88c746fedba`、
  `managed-executor-pool.ts 34348f1b011508f0cea1dad4d4a64bc19bf94807`、
  `browser-protocol.ts 1760626d99fbabe1d5f2737f1c1ce56c1deba6f1`。
- 本轮 runtime 为**本 worktree 重新构建**的 `playwriter/dist`（构建时间 01:42）：
  `aria-snapshot.js ece2a9bd8cfb4eb2…`、`managed-executor-pool.js 3808dbe1acc73c91…`、
  `managed-relay.js faee0c7655f21c97…`、`runtime-cli.js ba352bd6f5853ca7…`（sha256 前 16）。
  未重新构建/重载 Chrome 中已加载的扩展（仍为 0.0.131 / 19992）。

# 环境与生命周期

- Chrome PID 11586、`--user-data-dir=.../tmp/chrome-reliability-19992`；唯一 connected profile
  `profileId=18trj91a7isot`、epoch `epoch-mtx7xgyq-4zs3bqq9w5l8`（与首轮一致，未换 profile）；
  19989（PID 97678）未触碰，未启动任何新浏览器。
- runId `retest-20260911174322-e0779f97`；session `5899f09f-0061-4bfd-8fa8-361077ef783b`；
  fixture tab `ptab-mtx8vvzl-18zebbk1nyjtde`（chromeTabId 1547659840，本机 fixture
  `127.0.0.1:61187`）；测试 runtime 为 harness 自己 spawn 的前台子进程（PID 33490，
  `detached:false`），token/dataDir/log 均为 run-local；所有请求 requestId 唯一。
- 同一真实链路：Pi 工厂（12 tools）→ 真实 `BrowserRuntimeClient` → 19992 → 已加载扩展 → Chrome；
  仅显式 `request.cancel` 一项为 API-level（真实 client）。无 mock、无 fake pool/extension。
- cleanup：关闭 run 标签/组（tombstone 语义与首轮一致）、session_shutdown、fixture 关闭、
  只终结自己的运行时子进程（exit 0）；19992 已释放、无残留进程；discover 无 runId 残留；
  Chrome 存活。

# F1 实测（6/6 PASS）

| 步骤 | 结果 |
| --- | --- |
| `browser_snapshot search=影子分类` | ref `e11` role `disclosuretriangle` name `影子分类`（问题选择器已可执行） |
| 按该 ref + snapshotId 点击 | 42ms 成功；无 `strict mode violation` |
| 页面读取（evaluate 显式 return） | `shadowOpen=true`（`影子分类` 打开），light `#controls details` = 隐藏 sibling 未动、d0/d1 仍关闭 |
| fresh snapshot | shadow ref 与 light 第一 summary ref 同时存在（未被“整体抑制 shadow ref”掩盖） |
| 点击 light `结算分类` | 成功；light[1] open，hidden 与 shadow 不变 |
| 点击 light `配送分类` | 成功；light[1]/[2] open，hidden 与 shadow 不变 |

附加记录（informational，不计入 gate）：`browser_snapshot selector=#shadow-host` 作用域快照 ok=true。
未使用 `.first()` 猜测；click 均使用内容 JSON 中的 ref + 对应 snapshotId，evaluate 之后一律重新 snapshot。

# F2 实测（12/12 PASS）

| 步骤 | 结果 |
| --- | --- |
| `browser_network start`（timeout 之前既有 capture） | captureId `6bbd10d9-…` status active |
| 点击 fixture 按钮（真实 fetch POST） | list 收集到 `…/hit?tag=core&run=…` method POST status 200 |
| `browser_execute` timeout=1000ms + pending 6s | 1007ms 返回 `code=timeout · outcome=unknown`（不再 cancelled / 无 raw abort） |
| 计数不重放 | counter 1 → 1 |
| 超时后重新 list | **同一 captureId** + POST200 条目保留 |
| 新 worker 读取 | evaluate fixture 标题成功（无需重放动作） |
| 显式 `request.cancel`（API-level，真实 client） | 应答 ok；pending 返回 `code=cancelled · outcome=unknown`（与 deadline 可区分） |
| 取消后 | 计数仍 1；同一 captureId + 条目保留 |

# 未覆盖边界（本轮明确未测）

- 原 85 项矩阵中与 F1/F2 无直接关系的其余项（会话隔离、SPA/back、OOPIF、discover 排序等）未重跑；
  其上一轮 PASS 证据保持不变。
- 145 真实标签分页、hash 专项、真实站点/发帖场景未做。
- **物理 Pi 终端字体/真 TUI 屏幕仍未测试**；本报告与此前一样只覆盖真实工具链路 + 程序化组件渲染。
- 未做安全/性能/平台探测；未改动任何产品源码或既有报告。

# 证据

- `tmp/live-retest-cffbeea/{retest-run.mjs,fixtures.mjs,run.log,results.json,ledger.json,runtime-stdout.log,runtime-stderr.log,runtime/{relay-server.log,cdp.jsonl}}`
- 关键 requestId：F1 `…:browser_click:5`（后续 :8/:11）；F2 `…:browser_execute:17`、
  `…:apicancel-exec` / `…:apicancel-request`；captureId `6bbd10d9-5200-462f-af60-361d910b6757`。
- 首轮 FAIL 报告保持原样：`docs/exec/browser-reliability-live-acceptance.md`。
