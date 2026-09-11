---
title: Browser 可靠性候选 67cf33b 真实 Chrome 独立验收（live acceptance）
description: 经真实 Pi 工厂→HTTP runtime→用户已加载扩展的完整链路执行 85 项 live 检查；核心抓包/会话/接管目标通过，发现 2 个真实缺陷（open-shadow summary ref 选择器不唯一、page deadline 误报 cancelled）。
prompt: |
  用户授权：唯一 live 验收 agent 在 worktree acceptance@424e5dd（代码等同候选 67cf33b）上
  对用户已准备的 Chrome（PID 11586，独立 profile，已加载 fork 扩展 eeklahpecooapnailfaebkjjembkjhhg，
  RELAY_PORT 19992）执行真实浏览器验收；只允许在 ./tmp/live-reliability-67cf33b 写有限
  harness/证据并新增本报告；不得改产品源码、不得重建/重载扩展、不得触碰 19988/19989/19990/19991
  及日常 Pi；不重放真实发帖、不对真实站点提交，只在本机 fixture 上操作；只提交报告；
  不推送/PR/合并/tag；最终只交付 dev，main 与现行安装不动。
  依据 @AGENTS.md @pi/skills/SKILL.md @docs/exec/browser-reliability-{plan,acceptance,review}.md。
---

# 结论：FAIL（2 个真实缺陷，其余核心目标通过）

85 项检查：**83 PASS / 2 FAIL / 0 SKIP**。两个 FAIL 均为真实链路可复现的缺陷，建议路由修复：

- **F1（P2，功能）** open shadow root 内原生 `<summary>` 得到**非文档唯一**的结构选择器 ref；
  用该 ref 点击必然抛 Playwright strict mode violation（本轮匹配到 2 个元素）。
- **F2（P3，语义）** page 操作被服务端 deadline 强制终止时返回 `code=cancelled`
  （"Managed executor request was cancelled; worker was terminated"），而 `managed-relay.test.ts`
  对同一场景固定的是 `code=timeout`；真实 executor pool 的取消应答绕过了 relay 的 timeout 归类。

核心矩阵其余部分全部 PASS：连接与 profile 元数据、Pi 折叠/展开渲染与真实错误呈现、快照严格
范围与搜索 refs、超长中文/emoji 字节上限、details/summary 明暗计数、原生 select、保守失效
refs、延迟 SPA pushState → tabs.list 同步 → history back（draft/scroll 保留）、200ms 延迟启用
控件、**抓包在 worker 被杀（timeout）与显式 request.cancel 后仍保留同一 captureId 与既有条目、
计数不重放**、stop/start 语义、双 session 隔离、release→discover→attach 原地接管、OOPIF 子帧
请求归属。测试后 19992 已释放，Chrome 与用户自己的标签未被触碰。

浏览器阶段结束；本报告只提交在 `swarm/reliability-acceptance`，不构成合并授权。

# 环境与链路（全部实测，未 mock）

- 候选代码：worktree `tmp/swarm-reliability/acceptance`，HEAD `424e5dd`（代码等同候选 `67cf33b`）。
- Chrome：PID 11586，`--user-data-dir=.../tmp/chrome-reliability-19992`，仅一个 connected profile
  （label `Chrome`，profileId `18trj91a7isot`，browserEpoch `epoch-mtx7xgyq-4zs3bqq9w5l8`，
  `existingTabControl=true`）。始终只有一个 prepared profile；未启动第二个 Chrome/headless。
- 测试 runtime：本 worktree 构建产物 `playwriter/dist/runtime-cli.js`，作为 harness 前台子进程
  （`detached:false`）监听 `127.0.0.1:19992`，token `reliability-live-token`，数据目录
  `tmp/live-reliability-67cf33b/runtime`，log/cdp 路径均为 run-local；finally 中只 SIGTERM
  自己 spawn 的子进程（实测 exit 0），未接触 19988/19989/19990/19991。
- 产品链路：真实 `pi/extensions/index.ts` 工厂（12 tools + session_shutdown，jiti/Node TS 直载）
  → 真实 `BrowserRuntimeClient`（HTTP v1）→ 19992 → 用户已加载扩展 → Chrome；DOM/快照/抓包
  事实全部来自真实响应。仅“显式 request.cancel”一项明确标注为 **API-level**（真实 client，
  非 Pi TUI 工具），其余均为 Pi 工具路径。
- 两个 harness 会话 UUID：A=`b5ef6805-3545-47fe-a97a-f038f3a65c38`，
  B=`ccb1d024-af72-4f9d-9b8d-edabd32c18d7`；runId=`20260911172656-a4062ee5`；每个请求唯一
  requestId；资源 ledger 见 `ledger.json`。只操作 run 创建的 2 个 fixture 标签（127.0.0.1 与
  localhost 两个 origin，本地 fixture server，POST 只打本地 `/hit` 计数器），未访问任何真实
  站点、未提交任何表单/cookie。

# 结果摘要

| 段 | 场景 | 结果 | 代表性实测 |
| --- | --- | --- | --- |
| setup | 端口空闲→runtime→扩展连接→唯一 profile→12 tools | 5 PASS | 连接耗时 <0.5s；capabilities v1 全 true |
| A | 真实 Pi 折叠/展开行（profiles/group/tab） | 9 PASS | `✓ created MATRIX-… — 127.0.0.1:57776 · ready`；展开含完整 `tabId/groupId`（group 展开行）与 `tabId` |
| B | 严格范围选择器、搜索 refs、中文/emoji 上限、真实错误渲染 | 16 PASS | 2 匹配错误 380ms 内明确返回；0 匹配 5ms；无匹配 `No matches found` + refs=[]；40857B 内容无 U+FFFD、有截断标记、结构化 JSON 可解析 |
| C | details/summary（隐藏同级参与计数）、open shadow、原生 select | 7 PASS / **1 FAIL** | 首/次 summary 点击正确开合且隐藏 sibling 未动；select combobox ref 存在；**shadow ref 点击失败（F1）** |
| D | evaluate 后 ref 保守失效、fresh ref 单次成功 | 5 PASS | stale 点击 `code=stale-snapshot/not-started`，计数器 0→0；fresh 点击 1 次、计数器 1 |
| E | 延迟 SPA pushState、tabs.list 同步、back、延迟启用控件 | 7 PASS | 点击 27ms 返回旧 URL 观测；~0.6s 内 tabs.list 变 `/spa-after` + 新标题；back 19ms；draft 保留、scroll 33→33；延迟启用点击 297ms |
| F | 抓包 start/list/stop/restart、worker 被杀、显式取消、不重放 | 14 PASS / **1 FAIL** | 真实 POST(status200) 入列；超时 1012ms 杀 worker 后同 captureId+条目保留；显式 cancel 同样保留；计数器超时/取消前后不变（2→2）；stop 后不收集、显式 start 换新 buffer；**timeout 归类错误（F2）** |
| G | 双 session 隔离 + 真实小规模 discover 排序 | 8 PASS | B 对 A 的 tab 读/评估/抓包全部 `ownership-mismatch`；discover 把 A 的 tab 标为 `owned-by-other-session` 不可 attach；active-first 排序正确 |
| H | release→discover→attach 原地接管 | 6 PASS | 同一 chromeTabId/windowId、URL 不变；draft/scroll/iframe 保留；existing-origin group 不带 windowId（协议设计） |
| I | OOPIF：localhost 页内嵌 127.0.0.1 子帧请求归属 | 1 PASS | `Network` 事件 `http://127.0.0.1:57776/hit?tag=oopif` status 200 归属根 tab capture |
| cleanup | 关闭 run 资源、释放 session、停 runtime、Chrome 存活 | 5 PASS | 无 ready 状态资源；discover 无 runId 残留；19992 释放；Chrome PID 11586 存活 |

`tabs.close`/`groups.close`/`tabs.release` 后 session inventory 会保留 `state:"released"` 的
tombstone（协议设计），物理标签已删除（discover 与最终状态检查共同确认）；cleanup 断言按此语义。

# Findings

## F1（P2，功能）：open-shadow `<summary>` 的 ref 选择器不是文档唯一，点击必失败

复现（round2 requestId `20260911172656-a4062ee5:browser_click:20`；独立小探针 `shadow-probe.json` 再次复现）：

1. 页面在 open shadow root 内放一个原生 `<details><summary>影子分类</summary>…`，light DOM 另有一个
   同形的 `<details><summary>隐藏分类</summary>`。
2. `browser_snapshot` 给 shadow summary 生成了 ref（role `disclosuretriangle`，name `影子分类`）。
3. `browser_click`（`aria-ref=e11` + 该 snapshotId）失败：
   `locator('details:nth-of-type(1) > summary:nth-of-type(1)') resolved to 2 elements: 隐藏分类 / 影子分类`。
4. 页面侧计数确认该选择器在 light DOM 命中 1、shadow root 内命中 1；Playwright 的 CSS 引擎
   穿透 open shadow，故该“结构选择器”不唯一。

诊断：`playwriter/src/aria-snapshot.ts:941-948` 在越过 shadow 边界时只把 shadow 内部链压入
`segments`，若随后 `domById.get(parentId)` 拿不到宿主/上层节点，循环静默结束，
`aria-snapshot.ts:966-969` 直接返回这段**部分链**而不是 `null`。单元测试
（`aria-snapshot.unit.test.ts:813-833`）构造的 flattened DOM 带完整宿主父链，未覆盖真实
`DOM.getFlattenedDocument` 下该链不可解析的情形；iframe/closed shadow 会正确返回 null，只有
open shadow 走了这条“部分链”分支。期望：不可解析祖先链时返回 null（不给 ref），或保证生成
文档唯一选择器（宿主链以 `>>` 拼接）后验证唯一性。

影响：任何使用 web component + 原生 details/summary 的页面，其 summary ref 点击必然严格模式
失败；本轮其余 summary/选择器行为正常。

## F2（P3，语义）：page 操作 deadline 到期被报成 `cancelled` 而不是 `timeout`

复现（round1 `…:browser_execute:35` 与 round2 `20260911172656-a4062ee5:browser_execute:41` 两次一致）：

1. `browser_execute`（timeout=1000ms）执行 `await sleep(6000)`。
2. 1012ms 时返回：`Managed executor request was cancelled; worker was terminated · code=cancelled · outcome=unknown`
   （worker 确实被杀、新版 worker 随后可重新观测、抓包保留——这些目标都 PASS）。
3. 对照：`managed-relay.test.ts:1953` 与 `:2378` 对“page 操作 + relay deadline”固定
   `{ code:'timeout', outcome:'unknown' }`。

诊断：relay 的 deadline 路径 `managed-relay.ts:2028-2030` → `abortPending(reason:'timeout')`
→ `signalCancellationToOwner`（`managed-relay.ts:2585-2596`）对 page 操作调用
`cancelPoolRequest`，而 pool 的 `cancel()`（`managed-executor-pool.ts:137-143`）一律
`abortTask({reason:'cancelled'})`，其活动任务应答（`managed-executor-pool.ts:565-583`）带
`code:'cancelled'` 作为正常 response 直接返回，绕过了 relay `describeRequestError` 的
`pending.timedOut → code:'timeout'` 归类（`managed-relay.ts:3179-3181`）。fake test pool 在
abort 时 reject 而非回 cancelled response，因此测试固定的是 timeout，真实 pool 行为不同。
影响：模型对“自己的 deadline 到期”与“用户取消”得到同样的 `cancelled`，语义不可区分；
不重放/unknown outcome/抓包保留均不受影响。建议把 timeout 原因传入 pool.cancel（pool 已支持
`reason:'timeout'` 分支，见 `managed-executor-pool.ts:552/572/581`）。

# Harness 修正记录（round1→round2，均为 harness 用法错误，已排除）

round1（`tmp/live-reliability-67cf33b/round1/`）78 项中 8 个 FAIL 有 6 个是 harness 误判，修正后
round2 不再出现；产品缺陷 F1/F2 两轮一致：

1. `tabs.create` 展开行断言要求 `groupId`：实际展开只保证 tabId + 页面 url（group 不随 create
   返回）；改为 `tabId + url`。
2. 用默认快照取 `#fetch-hit` 的 ref：默认快照文本窗口被超长中文文本截断，窗口外节点按设计
   不返回 ref；改为 search 快照取 ref（顺带覆盖 search→ref→click）。
3. back 后按“点击前手动 scrollTo(0,900)”断言：Playwright 点击会把目标滚进视口（实际
   pushState 时刻 y≈4015），浏览器恢复到该位置才是正确行为；改为与 fixture 记录的
   pushState 时刻 y 比较（33→33 PASS）。
4. 用 `document.title` 判断 A 会话可读：back 后站点自身保留 pushState 设置过的标题；改为读取
   fixture 标题元素。
5. attach 后用 `group.windowId` 比对：existing-origin group 按协议不带 chrome windowId；改为
   重新 discover 对比同 chromeTabId 候选的 windowId/url 恒定。
6. cleanup 断言 `tabs.list` 为空：close/release 保留 `released` tombstone；改为断言无 ready
   状态资源 + discover 无 runId 残留 + 物理候选消失。

# 未覆盖/边界

- Pi 物理 TUI 屏幕与终端字体未验证：折叠/展开是调用真实 `renderCall/renderResult` 实现的程序化
  渲染。
- 145 标签真实分页未重跑（此前纯数据测试已覆盖）；本轮只验证真实小规模 discover 的 active-first
  排序与 candidateId 完整性。
- 未重放 Linux.do 发帖/特定 hash 验收；未做安全/性能/平台矩阵。
- 慢可操作控件仅验证 200ms 延迟启用成功（297ms），未构造 >5s 慢站证明上限；既有验收 P3 记录不变。
- 全程无 `.first()/.last()` 猜测、无不确定动作重放、无 `browser.close()/context.close()`。

# 证据

- harness：`tmp/live-reliability-67cf33b/{live-run.mjs,fixtures.mjs,cleanup-run.mjs,probe-shadow.mjs,state-check.mjs}`
- round2（本报告依据）：`tmp/live-reliability-67cf33b/{run.log,results.json,ledger.json,runtime-stdout.log,runtime-stderr.log,runtime/{relay-server.log,cdp.jsonl},shadow-probe.json}`
- round1（harness 修正前，含上述误判清单）：`tmp/live-reliability-67cf33b/round1/`
- 关键 requestId：F1 `…:browser_click:20`；F2 `…:browser_execute:41`（round1 `…:browser_execute:35`）；
  API-level 取消 `…:apicancel-exec` / `…:apicancel-request`。
