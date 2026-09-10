---
title: Browser Runtime v1 并行实现契约
description: 固定 Pi、relay、执行进程和 Chrome 扩展之间的接口与职责。
prompt: |
  根据本会话已确认的 Pi Browser Use 需求，制定可并行实施的接口契约。
  依据 @docs/exec/browser-rebuild-plan.md
  @playwriter/src/browser-protocol.ts @extension/src/background.ts
  @playwriter/src/cdp-relay.ts @playwriter/src/executor.ts
  @pi/extensions/index.ts @pi/extensions/bootstrap.ts
  不创建业务 agent 或 HITL 工作流；LLM 控制具名组和显式标签。
---

# 权威契约

编译类型来源：playwriter/src/browser-protocol.ts。
新实现必须遵守此处 kind/字段/返回，不能自行改名。
协调者是共享契约的唯一写入者；有缺口及时汇报，由协调者同时通知各端。

# 身份与资源

- sessionId = Pi session UUID，Pi 在每个请求中自动注入完整 UUID。
- profileId = 扩展生成并保存的安装身份，与邮箱、显示名无关。
- groupId / tabId = opaque logical string ID，不能等同 Chrome numeric IDs。
- 每 group 单一 owner session，固定 profile，name 必填且非空。
- 浏览器实体映射 chromeGroupId/windowId/chromeTabId 单独保存。
- browserEpoch 标识 Chrome 运行期；storage.session 与持久 storage.local
  配合恢复；完整浏览器重启不按 URL/组名自动接管。
- revision 单调递增，每次持久归属更新后发布 inventory。
- states：ready / disconnected / released / needs-rebind。
- released 为 tombstone，防止重连按旧记录拉回用户拖出的标签。
- group 永远不按标题合并；同名组合法，各自 ID 独立。
- 各 profile 的扩展是资源事实来源。relay 做 session 检查与缓存，不自行
  推导归属，不推回旧快照覆盖用户释放。

# HTTP

独立 runtime 默认 127.0.0.1:19989。环境 PI_BROWSER_HOST / PI_BROWSER_PORT /
PI_BROWSER_TOKEN / PI_BROWSER_DATA_DIR，不抢占日常 19988。

- GET /browser/v1/capabilities -> BrowserCapabilities。
- GET /browser/v1/profiles -> { profiles: BrowserProfile[] }。
- POST /browser/v1/request -> BrowserRequest -> BrowserResponse。
- 每次请求必须有 requestId / sessionId，requestId 可使用 Pi toolCallId。
- malformed JSON/字段 -> HTTP 400；未认证 -> 401；正常协议响应（含业务
  失败）-> 200 + ok false。客户端同样处理非 2xx 网络/服务错误。
- 运行时校验不能只 TypeScript cast。拒绝危险 URL scheme、空 name、
  非法 deadline、超长 code 等，并限制请求体与输出体大小。
- 请求创建组/标签成功响应必须包含 group/tab，管理查询使用 groups/tabs。
- profiles.list 为连接元数据；groups.list/tabs.list 严格按 sessionId 过滤。
- session.release 只释放 worker/CDP客户端，不删除组/标签/持久归属。
- request.cancel 以 sessionId+targetRequestId 定位，不能取消别人的请求。
- 默认 execute deadline 30s；允许请求设置，服务端约束上限 120s。
- cancel/timeout 已开始的动作返回 unknown，不自动重发任何页面动作。

# WS（扩展 ↔ relay）

所有旧 method 与 response shape 不变，新增命名空间：

1. 扩展在 WS 建立并恢复 registry 后主动发送：
   { method: 'browserInventory', params: BrowserInventory }。
2. 归属变化后发送新 revision 全量 inventory（小数据，非 DOM/网络日志）。
3. relay -> extension：
   { id: number, method: 'browserRequest', params: BrowserRequest }。
4. extension -> relay 使用旧 envelope：
   { id: number, result: BrowserResponse }。
5. extension 处理 groups.* / tabs.* / tab.resolve，以及 request.cancel。
   profiles.list / session.release 由 relay 处理。request.cancel 在 relay
   撤销 worker 的同时，对已发往 extension 的控制请求转发取消，使用
   相同 sessionId + targetRequestId；取消不得被普通 per-group 队列阻塞。
6. tabs.create 必须先在组窗口创建空白标签并立即入组，再导航目标 URL；
   持久记录和实际 groupId 校验完成后返回 ready，附 targetId/cdpSessionId。
7. 正在离线时 Chrome 组仍存在；transport reconnect 不调用 ungroup。
8. 手动拖出/取消控制写 release，不与 transient debugger detach 混淆。
9. 原始 CDP Target.createTarget 不能生成 managed 未归属标签；新 managed
   executor 不使用 context.newPage，创建统一经 tabs.create。
10. legacy profile 不发送 inventory，managed 功能明确 unsupported。
11. 每个 WS 有独立连接代际和控制请求 AbortController。socket close 立即
    使其失效；每次 await 后再做 Chrome 写操作前核验代际/owner/release。
    旧 socket 的请求结果不得通过新的 socket 发送。timeout/cancel 后只能
    停止后续操作，已发出的 Chrome 动作如实报告 outcome unknown。
12. 持久 create ledger 在首个有副作用阶段登记 pending/resource ID，再在
    成功阶段标 completed。SW 中断或取消后重试不能因缺 completed ledger
    重复创建资源；未确认结果返回 outcome unknown并列出可核验资源。
13. registry保存失败不伪装成功；下一次重试必须使用新的健康写队列并读取
    权威持久状态。恢复观察异步完成后重新对账用户释放/新revision，不能
    用旧Chrome快照覆盖期间写入的release tombstone。

# Managed CDP 路由

B 负责追加到现有 /cdp 客户端入口，可用 query：
  extensionId=<stableKey>&browserSessionId=<Pi UUID>&browserEpoch=<epoch>

- 每个 managed worker 固定 session/profile，不改变 legacy client 格式。
- 上游 CDP client 一对一 extension 仍可复用；Pi 多 profile 通过多个 worker。
- 可见 Target.getTargets、attachedToTarget、事件广播只限当前 owner 的 tabs
  和合法子 frame；逐命令检查 target/session 的归属，不仅过滤列表。
- managed Target.createTarget 和 Browser.close / context级破坏操作拒绝。
- 请求取消/worker失效时撤销对应 managed CDP连接；旧连接 epoch 禁止复用。
- control request 不做页面业务重试，只有 inventory 对账与连接握手可重试。
- per-profile 输入执行互斥，防止真实 Chrome 键盘焦点竞争。

# C / Executor 导出（B 必须直接复用）

文件 playwriter/src/managed-executor-pool.ts：
  export class ManagedExecutorPool implements ManagedExecutorPoolContract
  constructor(options?: ManagedExecutorPoolOptions)

类型从 browser-protocol.ts 导入：
  execute({request, tab, cdpUrl, connectionEpoch, signal?}) -> BrowserResponse
  cancel({sessionId,requestId}) -> Promise<void>
  releaseSession({sessionId}) -> Promise<void>
  disconnectProfile({profileId}) -> Promise<void>
  dispose() -> Promise<void>

C 不修改 cdp-relay.ts；B 负责实例化和集成。
C worker 使用 @xmorse/playwright-core 与已有 snapshot/helpers。
page 操作定位 tab.targetId，不 fallback pages[0]，不得按 URL 取 first。
可隔离复用每 session/profile worker；abort/timeout 终止进程并使其失效。
终止控制侧执行并不撤销已经发往浏览器/站点的动作，必须如实返回 unknown。

page.execute 保留 JS 逃生舱，但 scope 的 page 固定为请求 tab；context 若
提供则只暴露本 session/profile 页面，不提供 newPage/close 的未管控通道。
请求被取消/释放后不得继续发送 CDP 指令。执行器输出字符串/JSON须有上限，
network listener 精确按页面绑定清理。无验证码检测，无业务重试。

page.snapshot 返回 text + snapshotId；ref 索引按 tab/generation 存储。
click/fill 收到 aria-ref/@eN 必须带 snapshotId 并核验，无匹配不能 first()。
普通明确 CSS/role locator 可以无 snapshotId，仍遵守严格匹配。

# Pi 工具（D）

建议名称，不使用同名新旧混合注册：

- browser_profiles：list。
- browser_groups：list/create/rename/close；create name+profileId。
- browser_tabs：list/create/close/release；create groupId+url。
- browser_navigate：tabId+url，仅现有 managed tab 导航。
- browser_snapshot：tabId+search?/selector?/full?。
- browser_click / browser_fill：tabId+selector+snapshotId?。
- browser_evaluate：tabId+code（页面 JS）。
- browser_screenshot：tabId+path?/fullPage?/labels?。
- browser_network：tabId+start/list/stop+filter?。
- browser_logs：tabId+limit?。
- browser_execute：tabId+code+timeout?（Node/Playwright scope）。

headless PDF 不属于本轮 extension-only 默认工具，不保留必失败接口。
LLM没有sessionId参数，也不能通过名字模糊匹配其他会话的组。
重复调用 create 时同 requestId 应返回原资源，不多开标签（由 A/B 去重）。
D 不修改 package.json依赖，通知 E 添加 runtime dependency；boot路径先使用
PI_BROWSER_RUNTIME_PATH（配套CLI文件绝对路径）或 pi-browser-runtime executable。
禁止 npx latest 自动换上游版本；/browser-status 不创建 session/标签。
shutdown 调 session.release；不能关闭组。

# 配置与分发（E）

- 后台包改名 @tom-cat/pi-browser-runtime，路径仍 playwriter/。
- pi 包名保留 @tom-cat/pi-browser-use-extension。
- pi runtime dependency 由 E 使用 pnpm 添加。
- extension 当前 imports 依赖名字 playwriter，由 E 通过 workspace alias
  保持 import 兼容，或与 A/B 协调改名；不得新加 tsconfig 跨包path绕依赖。
- 新协议放后端源码暂作公共type来源。Pi可以编译期 type import包导出，
  运行期只通过HTTP；最终 types/export map 由 E+协调者接线。
- fork dev key、扩展origin allowlist、端口由 E 制定并通知 A。
- 本轮不发布，用户同意加载测试扩展前不启动任何Chrome。

# 验收

先纯状态转换/真实HTTP/真实worker测试，再用户配合Chrome故障注入。
不得使用mock返回值把未接通的两端伪装成通过；必须检查线协议。
实施分支只由其owner写入；共享契约更新由协调者同步。
