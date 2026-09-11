---
title: Browser 工具可靠性修复与 swarm 执行方案
description: 保留中断前抓包证据，修复定位、快照、发现、状态同步和 Pi 显示。
prompt: |
  用户确认执行：
  我觉得需要保留
  然后可以进行修复，还是像之前的swarm的方案一样，启动多个agent并行执行可以使用traex, codex, codebuddy。model 和effort都不要懂，用默认的就可以
  剩下的要求和上面进行重构的时候一致
  需要开chrome的时候告诉我就可以额
  用户补充合并边界：
  这次最后合并的时候应该不会直接合并到main上边吧，应该是会合并到一个开发的分支上面吧
  用户追加仓库指南任务：
  然后我看现在agents md还是旧的playwriter的agents md啊，能不能写成符合我们仓库开发环境以及要求的啊。这个也让一个agent去干一下呗
  上文确认：抓包必须在执行强制中止后保留已有记录；局部修复，不重构架构，
  不增加网站专用逻辑，不自动重放不确定动作。分工独立 worktree，功能分支
  提交和 PR，全新 agent 独立验收，Chrome 阶段先通知用户，验收后合并清理。
  依据 @README.md @playwriter/src/skill.md
  @docs/exec/browser-rebuild-plan.md @docs/exec/browser-runtime-contract.md
  @tmp/prior-diagnostic-evidence.json @playwriter/src/browser-protocol.ts
  @playwriter/src/managed-relay.ts @playwriter/src/cdp-relay.ts
  @playwriter/src/managed-executor-worker.ts @playwriter/src/aria-snapshot.ts
  @extension/src/managed-groups.ts @extension/src/background.ts
  @pi/extensions/index.ts @pi/extensions/runtime-client.ts。
---

# 范围与证据

基线 main 为 dfedbdc。集成分支 feat/browser-reliability，工作树
`tmp/swarm-reliability/integration`；主目录不写功能代码。
最终 PR 的目标分支是 dev，由基线 dfedbdc 创建。各 swarm 分支先合入
feat/browser-reliability，验收通过后仅合入 dev；本轮不合入 main。
main 的合并和当前安装更新均需用户另行明确授权。
原任务日志与独立测试的脱敏证据在 `tmp/prior-diagnostic-evidence.json`。

已确认：145 个候选只展示 61 个，活动页在末尾；只读 evaluate 清空引用；
搜索无匹配仍返回完整 refs；disclosuretriangle 缺少可操作引用；范围无匹配
等待到外层中断；中断杀掉 worker 后抓包证据丢失却返回普通空列表；URL/title
在扩展更新但未发布 inventory；Pi 摘要暴露不透明 ID、忽略执行值与捕获数量，
错误包含真实 ANSI ESC，展开错误仍被截断。

原 history back 在毫秒内实际完成，30 秒后 HTTP 中断。本轮独立页面同文档
back 25ms 成功：不能声称该特定等待问题已复现。旧 CDP JSONL 会轮转，
不能将日志中较早事件不存在解释成浏览器未发送 lifecycle。

站点分类依赖、重新提交入口、编辑器全屏原因、Cloudflare 警告不是本轮
通用工具修复目标。禁止重放真实发帖任务。禁止扩大成 CAPTCHA/HITL、
任意恶意 sandbox 调研、网站专用业务 agent 或整个浏览器引擎重写。

# 执行纪律

- 只用 codex、traex、codebuddy；model/effort 参数全部省略。
- 每个写入 agent 独立 worktree；不 external_agent_wait，不 sleep 轮询。
- 本次继承原 swarm 的功能分支提交、PR、独立验收、通过后合并清理授权，
  但最终合并目标限定为 dev，禁止以 main 为 PR base 或合入 main。
  只向 `tom-cat-mao/pi-browseruse-playwriter` 操作；gh 必须显式 `-R`。
- 不修改 Pi settings、主目录构建产物、已加载扩展或现行 runtime。
  不停止/重启/连接日常 19988、默认 19989、历史测试 19990/19991。
- Chrome 阶段先停止并通知用户，未获准备确认前不启动任何浏览器。
  默认 pnpm test 和 locator-selector.test.ts 会开 Chrome，禁止误跑。
- 不发布 npm、Web Store、GitHub Release；不推送 extension@* 标签。
- 保留 docs/exec/ppe-accept.jpg、签名密钥、旧兼容路径和原有改动。
- 各 worktree 首次 pnpm bootstrap + runtime build 后才能跑测试。
  pnpm 10.18.1；包目录 typecheck，测试 --run，浏览器无关配置。
- 只在 tmp 写临时文件；不 & 启动后台进程、不 pnpm dev、不 git revert。
- public changeset 使用 @tom-cat/pi-browser-runtime 或
  @tom-cat/pi-browser-use-extension；不手改 package 版本/CHANGELOG。
  fork issues 禁用（已执行 gh issue list），不引用不相关上游 issue。
- 实现者不担任最后验收者；先核对 diff 和测试，再安排全新 agent。

# 并行文件所有权

| 流 | Agent | 写入范围 |
| --- | --- | --- |
| A / runtime | Codex | browser-protocol.ts、managed-relay.ts、cdp-relay.ts、对应测试；新 runtime network 模块 |
| B / executor | TRAEX | managed-executor-worker.ts、aria-snapshot.ts、对应测试及局部辅助模块 |
| C / extension | CodeBuddy | extension/src、extension/tests、manifest.json |
| D / Pi | CodeBuddy | pi/extensions、pi/test、pi/README.md、pi/skills |
| E / guidance | CodeBuddy | AGENTS.md、旧指南来源、root agents.md script；必要的本地生成脚本 |
| 协调与验收 | 协调者/全新 agent | 本计划、进度、集成接线、最终验收报告与 PR |

各 owner 可新增自己的 changeset。跨所有权改动先说明接口缺口，由协调者
接线；不要自行编辑其他 owner 的文件。协议类型由 A 唯一编辑，必须可选
追加字段、保持旧 WS/HTTP 参数和结果 shape 兼容。

# A：长驻 runtime 抓包与服务端 deadline

1. 将抓包事实源放在长驻 runtime 的有界内存缓冲，而不是执行 worker。
   优先复用现有扩展 CDP Network 事件流；不可为每次调用再建浏览器连接。
   start 经权威 tab.resolve、所有权与 epoch 检查后启用该页 Network；
   list/stop 不依赖旧 worker 存活。若需要新的窄 CDP transport hook，由 A
   同时修改 managed-relay 和 cdp-relay，不能让 Pi 直连 CDP。
2. 保留已经收到的记录，即使 worker 超时、强制取消或重建；不重放请求。
   网络连接丢失时明确 interrupted；not-started 与 active+0 条严格区分。
   stop 停止收集但保留查询；下一次明确 start 可替换旧 capture。
3. 缓冲只存原有 URL/method/resourceType/status 等必要元数据，不抓 cookie、
   请求正文或响应正文。条数、字节、capture 数有上限，明确截断/丢弃计数。
   不落盘、不无限保留。session/tab 释放后不能给其他 session 读取；物理
   target 复用、browser epoch 变化、过时连接事件不能污染新 capture。
4. 兼容返回：list 的 value 仍为数组；start/stop 的 value 仍为对象。
   追加可选 data.networkCapture 元数据，推荐字段 status、captureId、
   retainedCount、droppedCount、reason。状态 active/stopped/interrupted/
   not-started。A 尽早回报最终 typed shape，协调者通知 D。
5. 队列等待消耗原请求预算；给 worker 的 timeoutMs 是真正剩余预算，
   不能从每层重新开始计时。协同 B 的操作内 deadline 和 D 的 HTTP grace。
6. page 操作可以携带可选 data.pageInfo {tabId, url, title?}，由 B 提供
   实际观测数据、D 用于 UI 上下文。旧客户端忽略即可，不改旧 value。
7. 测试验证真实消息路径、隔离、取消后记录可查、截断与旧事件排除；不要
   仅测试一个脱离调度链路的 Map 就宣称完成。

# B：定位、快照与导航观测

1. 范围 selector 零个/多个元素先明确报错，使用不超过 5 秒的短定位预算；
   同时限制实际 scope evaluate 的等待，避免 count 后消失产生无界等待。
   操作 deadline 短于 request timeout；不改变强制取消撤销 worker 的保障。
2. 格式化快照与 refs 使用同一可见范围（含搜索上下文/正文截断），不在
   No matches found 后继续返回整页 refs。沿用同次 shortRef 身份，不重新
   编号偷换含义；不得仅按名称或字符串模糊推导对应关系。
3. 为 disclosuretriangle/summary 补 DOM-backed 可执行 selector，注意该
   AX 角色不一定是 Playwright 支持的 ARIA role，不能直接制造无效 role。
4. 保留任意 evaluate/execute 后的保守失效规则，不能猜只读就跳过验证。
   在已有 snapshot/ref 结构中按需要补链接 href/控件状态，减少补读；这类
   字段必须有界，不把页面内容复制多份。错误说明失效后需新快照。
5. full 的文档/实现保持一致，不为节省 token 默认去掉用户要读的正文。
6. 明确 click 返回 URL 是即时观测；不 sleep 等所谓最终 URL，不自动补
   navigate，不重放动作。Back 的异常只在有证据时修改，不能谎报成功。
7. 追加可选 pageInfo（由 A 加类型），不为 UI 增加可能拖住动作的无界
   title/evaluate 等待。导航/snapshot已有信息优先复用。
8. A 从 relay 接管 page.network；B 暂不改 worker 的 network 代码块，
   避免并行冲突。协调阶段清理不再使用的路径或保持内部兼容，不双重收集。
9. 不擅自修改 playwright 子模块；若非改 fork 不可先报告证据。

# C：发现排序和 URL/title 同步

1. 在候选序列中优先 active，聚焦窗口作为辅助排序，不将它当成全局唯一
   当前页。组/profile 归属和原地接管行为不变。
2. chrome.tabs.onUpdated 的 URL/title 更新需合并发布 inventory，不对每个
   标题变化新增磁盘持久写。使用现有 revision/发布路径，错误可见。
3. 释放、换 epoch、断线重连时异步发布不能复活旧 owner，也不能让只改
   展示信息触发控制重新绑定。跨 profile 仍保持隔离。
4. 唯一版本 owner：manifest 0.0.130 -> 0.0.131；协调者负责集成后 local
   extension@0.0.131 tag，绝不推送标签触发 Release。
5. 原生 extension WS shape 不破坏，不改构建身份和端口。

# D：Pi UI、分页与客户端超时

1. 人类折叠视图优先网站/页面标题、动作、可验证结果；不透明 ID 保留模型
   content 和展开详情，显示短 ID 可兜底，不增加额外浏览器查询。
   页信息缓存必须按 Pi session 区分且有界，不跨 session 泄露标题。
2. 清理真实 ANSI/终端控制码后再缩略，Unicode/中文宽度安全，不能损伤
   model-facing 稳定 ID。错误展开能看到完整有界错误与 outcome，而非始终
   160 字；成功展开也不直接 dump 无界 raw details。
3. execute 展示 value/日志，network stop 展示保留数量和捕获状态；截图
   框架原有 image 渲染不能丢失。back 调用要展示 back 而不是空 URL。
4. browser_tabs discover 增加 Pi 层 offset/limit 分页，使用已有全量 discover
   API 后本地排序/分页，不向旧 relay 发送未知字段，不需要扩展新能力。
   默认小页；实际字节截断时 nextOffset 必须基于真正展示条数，不能跳过
   未展示条目。返回 total/returned/nextOffset/truncated 信息并测试 145 页
   活动页末位和超长标题。保留 profile/window/query/sourceTabId 现有语义。
5. HTTP grace 留给服务端返回正常 timeout 错误，不能与操作 deadline 同时
   触发。用户取消仍立即生效，独立 request.cancel、不 replay，不忽略 body
   读取超时。服务端 timeoutMs 仍上限 120 秒，额外仅响应传输宽限。
6. A 增加 networkCapture/pageInfo 类型前可先实现不依赖新字段的部分；
   协调通知后适配，不能通过 any 绕过。主动核对 model-visible content。
7. 读完整 Pi docs/extensions.md、docs/tui.md 和相关交叉文档，核对真实
   renderer API；增加纯 renderer 测试，不能只断言函数存在。

# E：仓库开发指南

将旧上游 AGENTS.md 改为本仓库的真实开发指南，同时修正其来源。当前
agentsdotmd 依赖未安装且引用不存在的本地模板；优先单一维护源，若保留
生成则输入全部入库、确定性生成可校验。删除旧单窗口/19988 默认杀进程/
上游包名与发布指令等误导内容，保留协议兼容、隔离、工作树、授权与测试
纪律。文档写当前已实现事实，不把 swarm 尚未验收的功能描述为已交付。
独立 worktree `guidance`，文档任务不修改运行代码或依赖，不需要 Chrome。

# 验收与收尾

先跑浏览器无关 typecheck、unit/integration、Pi tests/load-check、extension
纯测试和 build/smoke；报告真实 PASS/FAIL/SKIP。全新 agent 做独立 review。

Chrome 阶段只测试本轮变更：独立 fixture 的选择器错误、搜索 refs、下拉、
延迟 SPA URL、back、抓包在强制取消后保留、两个 session/profile 隔离和 Pi
显示。145 tabs 用纯数据测试，不创建 145 个真标签。不重新发帖、不点击
第三方业务提交按钮、不复活已排除的 hash 专项验收门槛。

需要用户打开 Chrome 时提供独立构建路径/端口，等确认后开始。验收通过
再将 feat/browser-reliability 通过 fork PR 合入 dev（显式 --base dev），
不合 main。保留构建与证据，最后清理工作树/分支，不删运行期引用中的
路径。默认本地 Pi 安装与 runtime 的更新必须单独确认时间。
