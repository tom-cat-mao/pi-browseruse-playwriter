# Firefox 操作与网络预算审查

操作 owner 分支 `fix/firefox-operations-audit`，基线 `f963175`。本记录为本次任务审查，
不替代运行期契约，也不代表 Firefox 实机验收完成。

## 已确认与修复

- P1（首批 `78ac892`）：attach/inject 未检查 executeScript 的目标 frame/error，
  注入失败可能仍提交归属。现校验目标 frame 并传播错误，可选预热保留既有语义。
- P1（首批）：resolve 落盘及子 frame 路由等待后缺取消检查；新建 tab 的请求上下文
  未记录实际 tab。现补检查与身份，避免取消/用户释放后继续派发动作，不重放。
- P2（本批）：旧网络配额只计算已完成文本与当前请求 chunks，忽略其他并发请求。
  200 个请求各 64 KiB 可暂存约 12.5 MiB；旧 string.length 与 byteLength 单位混用。

## 预算与清理

`firefox-network-budget.ts` 是生产路径使用的纯逻辑预算模块。每个 capture 2 MiB、
每个 request/response body 64 KiB；在途 chunks 使用 byteLength，保留文本使用 UTF-8
编码字节数。解码结束先归还该 body 原始字节，再按可用配额保留文本，无效 UTF-8 的
替换字符膨胀也受限制。文本不切断 surrogate pair；截断后不再续接后来的 chunks，
避免将中间缺失内容拼成看似连续的正文。

- 请求 body 和响应 body 共用 capture 配额；行淘汰释放两者。
- 同 requestId 的 redirect/reuse 先断开旧 filter、释放旧在途 chunks，再判断新 URL
  是否命中采集过滤条件。旧行已有正文仍计费，直到行被淘汰或 capture 被释放。
- `onCompleted` 先到时保留有活动 stream 的索引；`onstop`/`onerror` 先到时保留元数据
  索引直到 complete。只有两阶段都结束才移除；stop/eviction 可在任一中间阶段清理。
- `onstop` 将在途预算转成文本；`onerror`/请求失败释放在途预算。detach 先撤销 stream
  身份与索引，再 disconnect，晚到回调不能复活 body 或删除同 ID 的新请求。
- stop 保留已完成行及其正文预算供 list；restart/release 释放旧行全部预算，新 capture
  使用独立预算。body.release 幂等，重复释放或晚到数据不会使计数变负。
- ondata 始终先向原 stream 写入收到的原始 ArrayBuffer，才执行记录配额判断；截断
  仅影响采集副本。主动停止用 disconnect 放行余下响应，不因达到记录限额关闭响应。

## 验证与限制

纯逻辑测试使用实际预算模块，无 mock Firefox API：覆盖 200 请求并发、request/response
共用配额、UTF-8/emoji/无效字节扩张、源 buffer 不变与副本独立、重复释放、晚到调用、
旧/新预算隔离、满额及永久前缀截断。测试验证预算状态转换；WebExtension 事件回调接线
与 complete/stream 顺序为代码审查，不能冒称已执行 Firefox 事件或网络实测。

预算不是严格 OS/JS 堆内存上限：不包括元数据、JS 字符串内部表示、Firefox 提供的输入、
JSON.stringify、TextDecoder、拼接和结果序列化过程中的临时副本。既有 200 行限制保留。
真实缓存、重定向、网络失败、stream 事件顺序、页面接收原始响应以及取消竞态仍由独立
验收 owner 验证。DOM 模块、协议、manifest、构建脚本及用户运行环境均未修改。

本轮不运行 runtime unit/integration/默认 test，不启动浏览器、服务或独立 agent。
最终本地检查日志位于本 worktree 的 `tmp/logs/network-typecheck.log` 与
`tmp/logs/network-tests.log`。首次格式检查发现两处文件格式差异，Prettier 修正后复查通过。

| 检查 | 结果 |
| --- | --- |
| 扩展 TypeScript | PASS |
| 网络预算与资源纯逻辑测试 | PASS，2 文件 / 50 tests（预算 9、资源 41） |
| git diff --check / 修改 TS 文件格式 | PASS |
| runtime unit/integration、真实 Firefox、独立验收 | SKIP，按协调分工 |

## 第三批：navigate/back 响应旧 URL

独立基线报告 `../acceptance/acceptance/firefox-swarm/report-2026-09-13-baseline-0.0.136.md`
记录：back 的 pageInfo.url 仍为 `?history=next`，稍后 page.url() 才正确。P2 根因是旧
waitNavigation 在 goBack Promise 完成后直接轮询 tabs.get；动作尚未开始、旧页状态仍
complete 时直接返回。此缺陷有真实基线证据，本批不宣称修复后已实测。

最小修复路径改为动作派发前注册同一 native tab / frameId=0 的 webNavigation 监听：

- 过滤派发前的 timeStamp；跨文档要求 committed 后 completed，存在 documentId 时要求
  一致；缺少 documentId 时核对 commit/completed URL。最初版本将 commit 后新导航拒绝，
  此策略已由第四批修正为继续观察导航链。history/fragment 无需 URL 改变即可确认同文档变化。只看到旧 completed、子 frame
  或其它 tab 的事件不能确认本次动作。完整加载期间的 history/fragment 不提前结束加载。
- 同 URL reload 有 commit/completed 时正常完成；无事件的同 URL history/no-op 在 5s
  预算后返回 timeout + outcome unknown，明确不重放。已在 loading 的 tab 在派发前拒绝，
  避免将既有导航混作本次操作。
- 收到信号后读取 getFrame 与 tabs.get，核对完成 URL、可用的 documentId 和非 loading
  状态。不一致时返回 outcome unknown，不返回旧页信息；title 是此次 tabs.get 的当前值，
  不承诺之后不再异步改变。
- deadline 和取消覆盖 API action、事件等待以及事实读取全过程。超时、断线、用户释放/
  关闭会结束等待；晚返回的 API Promise 在下一步前检查等待是否结束，不重派导航。所有
  路径 finally 清理注册的监听、timer 与请求取消回调。导航成功不再额外等待 DOM 注入，
  既有 onUpdated 可选预热及后续正式页面操作注入仍保留。

本机 Firefox `/Applications/Firefox.app/Contents/Resources/omni.ja` 只读核对：
`modules/WebNavigation.sys.mjs` 的 STATE_STOP 成功发 onCompleted、onDocumentChange 发
onCommitted、onHistoryChange 分派 fragment/history；`ext-webNavigation.js` 用 Date.now()
生成事件 timeStamp。摘录仅保存在本 worktree `tmp/webnavigation-*`，未改浏览器文件或设置。
线上 MDN 本轮读取超时，未用未取得的网页内容作证据。

纯逻辑导航测试直接执行生产状态模块，覆盖旧完成/派发前信号、tab/frame 隔离、同 URL
reload、同 URL history、fragment、文档恢复、重定向、documentId 不匹配、加载期间 history
及错误终态。它不伪造 Firefox API，也不执行真实监听注册/清理；接线与取消路径为代码审查。
真实 navigate/back 响应、BFCache、同文档历史事件、取消与释放仍需独立验收复验。
WebExtension 没有本工具的动作关联 ID；用户/页面同时发起的新导航不能保证归因，本实现
对可观察到的不匹配保守失败，不声称浏览器事务隔离或所有同 URL 场景都可确认。

第三批最终检查：扩展 TypeScript PASS；导航/预算/资源目标测试 PASS，3 文件 / 60 tests
（导航 10、预算 9、资源 41）；Prettier 与 git diff --check PASS。日志为
`tmp/logs/navigation-typecheck.log`、`tmp/logs/navigation-tests.log`。runtime 整套与真实
浏览器 SKIP，仍由协调者/验收 owner 执行。

## 第四批：独立 CodeBuddy14 导航复审修正

- P1：原 committed(A) → before(B) 一律失败，会拒绝 location.replace、meta refresh 和
  登录页 JS 跳转。现重置当前 commit，继续观察后续主 frame 导航，仍在末尾核对 frame/tab
  事实；这种核对不能证明因果归属，WebExtension 无 actionId 的并发边界保持不变。
- 后续 before 保存已被替代文档的 ID/URL，重置当前 commit；旧 completion 在新 commit
  前不能完成新链，旧文档 abort 不杀死新链。新 commit 后优先用 documentId 排除旧事件，
  无 ID 时核对当前完成 URL，并过滤已替代 URL 的歧义 abort。缺少身份且旧/新 URL
  完全相同的事件无法证明归因；匹配的完成仍须通过末尾事实核对，不能将该核对当作 actionId。
- before(A) → committed(A) → history/fragment(A?changed) 现在更新已 commit 的 URL，
  仍等待 completed。无 documentId 时可匹配更新后的完成 URL；有 ID 时拒绝旧文档的
  history/fragment，避免污染新文档事实。
- 内层 Promise.all 同样 race interrupted，使导航事件等待在取消/超时后收敛；不将此前
  无根 pending Promise 描述为确定内存泄漏。不更改原生浏览器 Promise 的实现或重放动作。

保留刻意边界：已 loading 的 tab 派发前拒绝；无事件 no-op 返回 timeout/outcome unknown。
此批只改导航状态、导航等待的一行中断接线、测试与发行/审查记录，没有改其他模块行为。
新增回归直接运行生产状态逻辑，覆盖有/无 documentId 的导航链、旧 abort/完成、同 URL
替代、加载期间 history/fragment URL 变化、旧文档 history 干扰。真实 location.replace、
load 时 replaceState/fragment 及最终构建由独立验收 owner 复验。

第四批最终检查：扩展 TypeScript PASS；3 文件 / 64 tests PASS（导航 14、预算 9、资源 41）；
修改文件格式与 git diff --check PASS。日志为 `tmp/logs/navigation-chain-typecheck.log` 与
`tmp/logs/navigation-chain-tests.log`。runtime unit/integration、真实浏览器 SKIP；未 push。

## 第五批：0.0.137 实机导航候选过早锁定

分支 `fix/firefox-navigation-settle`，基线 `0d91d79`。读取独立完整证据
`../acceptance/tmp/firefox-swarm-acceptance/evidence-2026-09-13T04-18-13-683Z/`
及最终 `.137` 报告：四种导航链 4/4 稳定失败，随后读取已到最终 URL。

确定根因范围：完成 result 阻止后续事件，单次 resolve 锁定旧 URL，随后一次 metadata
不一致立即失败。现完成仅为候选，before/commit 撤销候选，完成后的 history/fragment
更新候选；同 documentId 的 completed 携带旧请求 URL 时保留已观测的 history URL。
原期限内每 25ms 重查，连续两次同候选、同可用 documentId、frame/tab URL 一致且 tab
complete 才返回。25ms 是重查间隔与最小观测跨度，不是 sleep 后直接成功；不一致继续
观察，超时仍 outcome unknown。无法保证返回后永远没有导航或识别未来延迟 meta refresh。

数值 abort 的源码定位：只读本机 Firefox omni.ja 中 `modules/WebNavigation.sys.mjs`
第 287–296 行，STATE_STOP 非成功分支生成 `Error code ${status}` 并发 onErrorOccurred；
`ext-webNavigation.js` 第 133–134 行原样传递。本机 getFrame 从 BrowsingContext 同步取
frame 事实，并非查询旧 actor 的 Promise；tabs.update 派发 load 后 convert，goBack
直接调用原生方法。原始证据没有 API 调用栈，不能把该次失败绝对归因到具体调用，但
精确文案有明确的事件生成路径，不应臆测为 getFrame actor 错误。

仅暂存已选 tab 主 frame、当前导航匹配的 `Error code 2152398850` 事件。后续 before
或 commit 必须证明 URL 或可用 documentId 不同，才能解除待定 abort；再经完成候选和
重复事实核对才成功。仅 completed、同 URL 且缺身份、没有替代导航均不能洗掉 abort，
最终超时。action/getFrame/tabs.get Promise 异常没有新增 catch，权限、非法 URL、无
history 等 API 错误保持传播；没有未经证据支持的 actor-error 吞错规则。

生产状态测试覆盖完成后 history/hash、meta refresh、abort 先于替代事件、缺少替代证据、
读事实期间替代文档、旧文档事实、元数据尚未收敛、超时/取消 stop 后的晚事件，以及其它
错误保持终态。没有新增 mockFirefoxAPI。停止状态由 finally 调用；action、读取、重查
均 race 同一 interrupted，重查 timer 在局部 finally 清理，外层清理监听与原 timer。
API Promise 异常传播和原生监听清理属于代码审查，纯状态测试不冒称执行真实 actor/API。

本批本地验证：extension tsc PASS；导航/网络预算/资源无端口测试 PASS（3 文件 / 73 tests：导航 23、预算 9、资源 41）；无代码注释、公共协议/权限/CSP/manifest/DOM/网络源码改动。完整 runtime 套件
SKIP，由协调者串行；真实 Firefox SKIP，只交 CodeBuddy15 复验。遵照本次“不再委派”，
本 owner 未安排新 agent；最终独立 review/验收由协调者安排，未 push 或合并。

`.138` 定向复验：四项稳定失败各重复运行，并核对返回 URL 与紧随的 page.url；普通
navigate/back、fragment/back 回归；meta/location 的旧 abort 先于/晚于替代开始；取消/
释放中断后无迟发动作；无事件 no-op、正在 loading 拒绝和非法请求错误边界。若仍有
数值 abort，需带同 tab 主 frame 事件顺序及 action/getFrame 调用阶段的定向证据，不能
仅凭最终页面已到达就扩大忽略规则。
