---
title: Browser 可靠性修复集成独立验收（67cf33b）
description: 全新验收 agent 对集成候选 67cf33b 相对基线 dfedbdc 的浏览器无关检查、实际函数探针与剩余 Chrome 场景。
prompt: |
  用户授权：全新独立验收 agent（非实现者）评估集成候选 67cf33b vs 基线 dfedbdc，
  worktree/branch swarm/reliability-acceptance；只允许 bootstrap/build/运行浏览器无关
  测试、在 ./tmp 下写证据并新增本报告；不得改源码/既有快照/测试、不 -u、不自动修复；
  发现缺陷返回精确复现与代码行并判 FAIL；只在最终提交报告；不推送/打 tag/PR/合并；
  最终只交付 dev，main/现行 Pi/runtime/扩展不动。原 Linux.do back 挂起未复现，
  不得声称已修复；验收请求预算反馈。
  依据 @AGENTS.md @docs/exec/browser-reliability-plan.md @docs/exec/browser-reliability-review.md
  @tmp/prior-diagnostic-evidence.json 以及实际 diff dfedbdc..67cf33b。
---

# 结论

**浏览器无关就绪性：PASS（无阻塞性缺陷）。** 独立复跑候选树（67cf33b）的类型检查、
unit、integration、build/smoke、扩展与 Pi 测试全部通过；三个自写探针直接调用构建产物
中的实际函数并通过 98/98 断言。未发现需要协调者路由修复的缺陷，因此本报告不判 FAIL。
浏览器行为本身（真实 Chrome 的消息链路、原生控件解析、SPA 导航时序）仍需另有 Chrome
阶段确认，见"仍需真实 Chrome 的场景"。

本报告只覆盖浏览器无关证据；它不构成合并授权，也不改动 main、现行 Pi 安装、runtime
或已加载扩展。报告自身提交在 `swarm/reliability-acceptance`；合入 dev 仍由协调者执行。

# 范围与环境

- 候选 `67cf33b`（`swarm/reliability-acceptance` = `feat/browser-reliability`），基线
  `dfedbdc`，merge-base 即基线；`git rev-list --count dfedbdc..HEAD` = 21 个提交。
- 变更面：runtime 网络保留/竞态、executor deadline/快照范围+refs+summary 选择器+
  pageInfo、Pi 模型可见输出/UI/分页、扩展发现排序与页信息发布、AGENTS 指南。无
  website/db/CAPTCHA/hash gate 等范围外改动（diff 扫描仅命中计划与指南里的禁止性文字）。
- 环境：Node v26.8.2、pnpm 10.18.1、Bun；`git submodule update --init` 后 playwright
  固定 `2074cbb1d4d3ce9274ec10c7d7834d4a7aba1d64`；`pnpm bootstrap` + runtime build
  成功；全过程未启动 Chrome，未使用 19988/19989/19990/19991 上任何进程（19988/19989
  为验收前既存用户进程，PID 68650/97678，未触碰、未重启）。
- 工作树卫生：bootstrap 造成的 `pnpm-lock.yaml` churn 已按原文件复制还原（`cmp` 一致），
  验收结束时 `git status` 干净；未 reset 任何源码，submodule SHA 未变。

# 浏览器无关结果（实际命令与实际计数）

| 检查 | 结果 | 命令与计数 |
| --- | --- | --- |
| runtime typecheck | PASS | `playwriter`: `pnpm typecheck`（tsc，exit 0） |
| runtime unit | PASS | `playwriter`: `pnpm test:unit --run` — 20 files / 260 tests |
| runtime integration | PASS | `playwriter`: `pnpm test:integration --run` — 4 files / 34 tests（串行，无端口残留） |
| runtime build + smoke | PASS | `playwriter`: `pnpm build`；`pnpm smoke` — `smoke check ok: @tom-cat/pi-browser-runtime@0.5.0, bundled extension eeklahpecooapnailfaebkjjembkjhhg on 19989`（仅包检查，未启动监听） |
| 扩展 tsc | PASS | `extension`: `pnpm exec tsc --project .` |
| 扩展测试 | PASS | `extension`: `pnpm test --run` — 5 files / 43 tests |
| Pi typecheck | PASS | `pi`: `pnpm typecheck`（tsc --noEmit） |
| Pi 测试 | PASS | `pi`: `pnpm test --run` — 3 files / 93 tests |
| Pi load-check | PASS | `pi`: `pnpm load-check` — 12 tools + `/browser-status` + `session_shutdown` registered OK |

未运行默认 `pnpm test`、`locator-selector.test.ts`、`aria-snapshot.test.ts`、
`snapshot-tools.test.ts`（会启动 Chrome）。日志见 `tmp/acceptance-67cf33b/*.log`。

# 独立探针（直接调用实际函数，无 mock）

探针在 `tmp/acceptance-67cf33b/probes/`，全部 PASS：

1. `worker-format-probe.mjs`（22/22）— 直接 import 构建后的
   `playwriter/dist/managed-executor-worker.js`：2400 行中文/emoji 快照的字符/UTF-8
   字节双上限、不切断码点（无 U+FFFD）、marker、可见 refs 与可见文本一一锚定、
   refs JSON 预算耗尽时文本与 refs 同步停止、搜索无匹配返回 `No matches found` 且空
   refs、`calculateNativeOperationTimeout` 边界（含正好 250ms reserve 得 0）、
   `attachObservedPageInfo` 只允许 navigate/back 贡献观测标题。
2. `network-store-probe.mjs`（33/33）— 直接 import
   `playwriter/dist/runtime-network-capture.js`：not-started 与 active+0 区分、条目仅含
   url/method/resourceType/status（含 cookie/请求体的输入不落库）、stop 保留证据且
   幂等可查询、暂停后事件不再收集、显式 start 才替换、filter 与 list filter 语义、
   session/connection/CDP session 隔离、子 frame 事件归属根 capture、connection/epoch
   变化→interrupted、ownership 变化/释放→删除、500 条截断与 droppedCount、超大单条丢弃、
   64 capture 上限抛类型化错误且不驱逐既有证据、deleteSession 仅清本 session。
3. `pi-shaper-probe.ts`（43/43，经 jiti 加载真实 Pi 工厂 + 真实 HTTP client +
   test-owned 临时端口服务端）— snapshot 文本用真实 worker formatter 生成后经真实
   shaper：文本原样进入 content、结构化 JSON 可解析、refs 数量/集合与 worker 窗口
   一致、snapshotId 含中文不被改写、pageInfo 进入模型 content；145 候选 discover：
   活动页（原序列末位 144）排第一、`total=145 returned=20 nextOffset=20 truncated=true`、
   分页游标走完全部 145 个唯一 candidateId 并终止于 nextOffset=none、字节截断页
   `nextOffset` 等于实际返回数（不跳过条目）、线路上不带 offset/limit 且保留原 filters；
   network stop 展示 status/retained/dropped/captureId 与旧 value 回退计数；真实 ANSI+
   中文错误在折叠/展开都不含 ESC，展开保留 160 字以后的尾部，抛出的模型侧错误保留
   code/outcome；A 会话标题绝不进入 B 会话行，`session_shutdown` 只清本会话缓存并只
   发送本会话的 `session.release`；evaluate 的业务 `value.title` 不成为 `pageInfo.title`。

# 关键交叉边界核对（对照用户要求）

- 网络证据：保留在长驻 runtime 的 store（`runtime-network-capture.ts`），start 只在
  `Network.enable`、deadline、token、owner/epoch 全部成功后同帧替换
  (`managed-relay.ts:2246-2270`)，stop 直接失效 pending token 且不排队
  (`managed-relay.ts:2138-2141`)，list/stop 不依赖 worker；中断/停止/未开始状态可查询。
- deadline 预算：relay 先建 `deadlineAt`，worker 只拿剩余预算
  (`managed-relay.ts:2081-2084`)，executor 内部再按 reserve 计算原生 timeout
  (`managed-executor-worker.ts:1257-1266`)；integration 有"队列等待消耗预算"用例。
- refs 失效：evaluate/execute 无条件 `invalidateSnapshot`
  (`managed-executor-worker.ts:1110`，evaluate 同步路径同)：任意只读 evaluate 之后 ref
  不可用，错误信息说明需重新快照。
- summary 控件：`disclosuretriangle` 不再生成无效 ARIA role，只有 DOM 证明是
  `<summary>` 时才用 `:nth-of-type` 结构选择器；闭合 shadow/iframe 文档返回 null 不给
  ref；隐藏同级仍参与 nth 计数（aria-snapshot.unit.test.ts:744-863 与探针共同确认）。
- 发现排序：扩展 `compareDiscoveredTabs` active-first、focus 仅破平、window/index 稳定
  (`managed-groups.ts:196-207`)；Pi 本地分页不改写旧 wire 字段，`nextOffset` 基于实际
  返回条数。
- 页信息发布：`noteChromeTabPageInfo` 只做内存 mutate + 250ms 固定窗口合并
  `publishInventory`，不调用 persist（无逐标题磁盘写），并以 connection generation
  拦截过期发布 (`managed-groups.ts:2049-2071`)。释放 tombstone 不会被复活。
- UI：真实 ANSI 在缩短前剥离、按显示列宽截断；完整稳定 ID 保留在模型 content 与展开
  详情；session 缓存按 Pi session 隔离且有界。
- Linux.do back 挂起：本轮无任何证据复现（前次诊断为同文档 back 25ms 成功）；本报告不
  声称根因已解决、也未要求它必须解决。改动只涉及 back 的预算与如实报告。

# Findings

无阻塞性缺陷，未发现需要回退或按 FAIL 处理的问题。以下为非阻塞记录，均不改变结论：

- P3（行为变更，建议 Chrome 复核）：click/fill 的原生 actionability 上限被固定为
  `min(剩余预算, 5s)`（`managed-executor-worker.ts:719,750,753`），相对 Playwright 默认
  30s 更严格；对"元素数秒后才可操作"的慢页面可能更早失败。changeset 明确写了 5s 选择器
  上限，属有意取舍，浏览器阶段用慢可操作 fixture 确认是否符合预期即可。
- P3（信息性）：relay 已托管 `page.network`（`managed-relay.ts:1864`），worker 内
  `case 'page.network'`（`managed-executor-worker.ts:625`）成为不可达分支；不会双重收集，
  作为内部兼容残留可后续清理。
- P3（信息性）：Pi client 严格校验 capture status 枚举
  (`pi/extensions/runtime-client.ts:303,323`)，未来协议若新增状态值需同步老客户端；当前
  冻结协议内无影响。

# 仍需真实 Chrome 的场景（浏览器无关无法覆盖）

1. 真实扩展经 `sendCdpCommand`（server source）打开 `Network.enable` 后，页面导航/XHR
   事件确实进入 runtime store；含 OOPIF 子 frame 事件的归属。
2. 真实原生 `<summary>`（普通文档与 open shadow root）能按结构选择器命中；iframe 内
   summary 无 ref 且不误指向顶层。
3. 真实 SPA 延迟 `history.pushState`：click 立即返回旧 URL 的如实观测，且
   `onUpdated` 合并发布在 ~250ms 内让 tabs.list 的 url/title 更新。
4. 慢可操作 click/fill 在 5s 上限下的实际行为（见 P3）。
5. 145 个真实标签下 discover 活动页置顶与翻页游标。
6. 真实 runtime 错误串（含 ANSI）在 Pi TUI 的折叠/展开呈现。
7. worker 被强制取消/超时（pool kill）后，真实链路上的网络证据保留与状态区分端到端。
8. 原 Linux.do 同文档 back 挂起：本轮未复现，如再出现需专门抓取生命周期证据。

# 边界声明

integration/HTTP/WS 测试使用仓库既有 fake extension/pool 与 test-owned 服务端，验证的是
软件路径与契约，不是真实 Chrome 行为。本验收未运行任何浏览器工具、未 attach 任何用户
标签、未改 settings/扩展/runtime。探针的服务端为脚本化 wire responder，仅用于让真实 Pi
shaper/client 走完整序列化路径。

# 证据

- 日志：`tmp/acceptance-67cf33b/{bootstrap,build-runtime,playwriter-typecheck,
  playwriter-unit,playwriter-integration,playwriter-build,playwriter-smoke,
  extension-tsc,extension-test,pi-typecheck,pi-test,pi-load-check}.log`
- 探针：`tmp/acceptance-67cf33b/probes/{worker-format-probe.mjs,network-store-probe.mjs,
  pi-shaper-probe.ts,pi-shaper-probe.log}`
- 包与版本：Node v26.8.2 / pnpm 10.18.1 / playwright 2074cbb1d4d3ce9274ec10c7d7834d4a7aba1d64。
