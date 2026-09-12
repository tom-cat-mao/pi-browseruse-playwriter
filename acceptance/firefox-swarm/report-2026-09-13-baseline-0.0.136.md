# Firefox swarm independent acceptance — 0.0.136 baseline

日期：2026-09-13。分支 `test/firefox-swarm-acceptance`，基线 `f963175`（0.0.136）。
角色：独立验收 owner，只编写/运行验收 harness、fixture、证据与报告，未修改任何产品源码。

Harness：`acceptance/firefox-swarm/firefox-swarm-acceptance.mjs`
原始证据：`tmp/firefox-swarm-acceptance/evidence-2026-09-12T17-33-17-346Z/`（`evidence.json` + `report.md`）

## 结论

**原始实跑计数：PASS 77 / FAIL 8 / SKIP 1（+9 findings）**。预检未阻断（唯一 connected profile、
版本 `0.0.136`、无多连接歧义），但这不代表产品可用：基线仍发现 8 项与已声明能力不符的真实 Firefox
运行问题，其中多项已由平台 owner 接手。**不能宣称 Firefox 与 Chrome 对等，也不能把预检未阻断写成
产品无阻断。**

> **计数口径说明**：上面的 `FAIL 8` 是 2026-09-12 原始实跑的原始计数，**未被改写**。其中 1 项
> （复合跨 shadow CSS）在本轮范围校正中被单列为「未交付限制」——这是**后续范围分类调整，不是重新跑
> 得到的计数**；原始 FAIL 包含该项，最终复验时才按新分类呈现。

## 基线之后的状态（2026-09-13 更新）

已按协调者要求**停止一切真实浏览器动作**，等待其它 owner 修复与协调者集成。本 harness 已扩展
用于下一版复验，但**尚未对新版本运行**：

- **iframe-geometry**（新增）：无变换同/跨源 iframe 动作；带 border+padding 的点击坐标映射；
  父层遮挡必须拒绝（或目标未被激活）；`scale/rotate/perspective` 几何不确定必须显式
  `unsupported-capability` 拒绝，不得以包围盒近似。
- **network-filter**（新增）：6 路有界并发、UTF-8 JSON 正文字节级正确、大响应（3 MiB）完整或
  显式截断、stop→restart 后新请求被采集且旧记录不被静默丢弃。预算口径为**原始在途字节 +
  保留 UTF-8 字节**，不是 OS 内存上限。
- **page.back**（收紧为断言）：响应 `pageInfo.url` 必须等于返回后实际 URL（`page.url()`）；
  不一致即 FAIL。该项已交 Codex 修复。
- **open shadow DOM**：复合 CSS `#shadow-host input` 与显式链式
  `page.locator('#shadow-host').locator('input')` **分别独立断言**；修复链式不得宣称复合也已支持。
- **console**：`console.log` 后页面必须能继续执行（DOM 追加必须发生），且不得产生 `length`
  越权 page error，二者均为必需断言。
- **未启用任何用户权限/远程调试**，未改用户弹窗设置。

## 环境（从 runtime 实测）

| 项 | 值 |
| --- | --- |
| runtime | `http://127.0.0.1:19991`（`19989` 未触碰） |
| 扩展版本 | `0.0.136`（`/extensions/status`） |
| connected Firefox profile | 恰好 1 个：`profile-8b59b267-d230-43c0-aa20-c9d90815ad16` |
| connectionId | `mtymrts5_hbanbr` |
| browserEpoch | `epoch-007c624a-d48a-4e85-ad95-4c0ed0fb16b1` |
| capabilities | `webextension` / `dom` / `dom-aria` / `dom-compatible` / `isolated` |
| 验收 session | 每次运行独立 `crypto.randomUUID()` |
| fixture | 本进程前台起的两台 127.0.0.1 随机端口 HTTP 服务，结束时关闭 |

预检：唯一 connected profile、版本 `0.0.136`、无多连接歧义；否则立即以阻断退出。

## 通过的关键能力（PASS 摘录）

- 归属与资源：`groups.create`/`tabs.create` 返回稳定 ID；`tabs.list({groupId})`、
  `tab.resolve` 一致；创建返回 `about:blank` 后 URL 会自行 settle。
- snapshot/ref 身份：`snapshotId` + 唯一 ref（role/name）；按 ref `page.fill` 生效；DOM 变化后
  复用旧 ref 报 `stale-snapshot`。
- role/表单：`getByRole`/`getByLabel`/`getByTestId`，input/textarea fill、checkbox、select、
  contenteditable fill、submit 点击后的 **页面真实 DOM 结果** 全部正确；DOM 点击
  `isTrusted=false`（符合文档边界）。
- 隐藏性：`hidden`、`aria-hidden` 祖先、`inert` 子树均被 snapshot 与 role 定位排除。
- open shadow DOM：role/label 定位可 fill + click 并改写页面 DOM。
- 导航：`page.navigate`/`page.back` 真正改变 URL（用 `page.url()` 复核）。
- 截图：plain / labels 均产出非空 PNG（写入验收目录）。
- network：start → 触发 fetch → list 保留该请求（status + 有界响应体）→ stop 后仍保留。
- logs：`page.logs` 能捕获 `console.log` 文本（但见 FAIL：桥本身有缺陷）。
- execute 读取：`page.title/url/content`、locator textContent/count/getAttribute/isVisible、
  `getByRole` count。
- 明确拒绝：未授权 `userScripts` 时 `page.evaluate` 返回 `unsupported-capability` 并点名权限，
  不自动开权限；execute 中 `page.mouse`/`page.keyboard.down`/内层 evaluate 均明确拒绝。
- 定位严格性：缺省 selector `count()=0`；歧义 role 动作被拒（无 `.first()` 回退）；缺失 selector
  动作按 3000ms 运行时 deadline 返回 **typed timeout**（非客户端 abort，非产品 bug）。
- release/隔离：release 后拒绝控制；第二 session 看不到、也操作/关闭不了第一 session 的组与标签；
  被 release 的物理标签可经 discover+attach 重新接管后正常关闭。
- 空闲稳定性：96s 内 25 次只读采样，`connectionId`/`browserEpoch`/版本/connected 不变（未向扩展发操作）。
- 清理：所有自建组/标签关闭；`tabs.discover` 复核无任何 fixture 物理标签残留（released 记录为预期 tombstone）。

## FAIL（执行过、与声明能力不符）

> 下表按本轮范围校正列出 7 项。**原始实跑为 8 项**：多出的 1 项是复合跨 shadow CSS，
> 已按本轮范围校正移入下方「未交付限制」（后续范围分类调整，非重新跑得的计数）。

| # | 区域 | 期望 | 实际 | 最小复现 |
| --- | --- | --- | --- | --- |
| 1 | shadow-dom | 链式 `page.locator('#shadow-host').locator('input')` 应进入 host 的 shadowRoot（必需能力） | `count=0`（非等待型 count，排除自造超时） | `page.locator('#shadow-host').locator('input').count()` |
| 2 | iframe 同源 | 指南声明 frameLocator 动作可用；读已 PASS | `unsupported-capability`：`Firefox getBoxQuads is required to verify the frame content box` | `page.frameLocator('#local-frame').locator('#frame-input').fill('Frame v2')` |
| 3 | iframe 跨源 | 同上 | 同一 `getBoxQuads` 拒绝 | `page.frameLocator('#cross-frame').locator('#xo-input').fill('Cross v2')` |
| 4 | logs | `console.log` 后页面能继续执行 | 页面 `#event-log` **未追加** `page console.log emitted`，即页面 realm 的 `console.log` 抛错 | 点击按钮执行 `console.log('x'); eventLog += 'appended'` |
| 5 | logs | 捕获一条普通 `console.log` 不应产生额外页面错误 | 每次 console 调用额外产生 `[error] Error: Permission denied to access property "length"`，位置指向页面调用点 | `console.log('plain string')` 后 `page.logs`（log/warn/error 与对象/Error 参数均可复现） |
| 6 | insecure-context | 普通 http 页面 snapshot 应可用 | `execution-failed`：`Firefox content script returned an invalid result` | 受控标签打开 `http://localtest.me:<port>/`（页面 realm `isSecureContext=false`、`crypto.randomUUID` 为 `undefined`，经浏览器标题 API 独立读取）后 `page.snapshot` |
| 7 | insecure-context | 普通 http 页面 locator 读取应可用 | 同 6 的 `invalid result` | 同源 `page.locator('#probe-heading').textContent()` |

FAIL 2/3 与 4/5 已分别由平台 owner 接手（iframe 严格边界、无变换的 frame fallback；console bridge
`firefox-dom.ts original.apply(pageView.console, args)`）。FAIL 6/7 与 owner 的
`view.crypto.randomUUID`（SecureContext）假设一致，**证据为高置信运行期对照，但不是内容脚本
堆栈级根因**，修复尚未集成，故不宣称 P1 已定案。FAIL 1 是链式遍历缺口，**链式必须实际成功**；
其与复合跨 shadow CSS 是两件独立的事（见下）。

## 未交付限制（SKIP，不称已修）

- **复合跨 shadow CSS**（`page.locator('#shadow-host input')`）：**原始实跑记为 FAIL（count=0）**；
  按本轮范围校正，本轮**明确不交付**完整跨 shadow 解析器，故单列为「未交付限制」——这是
  **后续范围分类调整，不是重新跑得的计数**。集成后的模型 capabilities/guide 将声明：native CSS 在
  **每个 document/shadow root 内**匹配，跨 host 可用**显式链式** locator 或 role/label/text。
  原始 `count=0` 证据保留；harness 中该断言已改为 SKIP + limitation finding，**不能称已修**。
- `target=_blank` 的 `sourceTabId`：DOM 点击是非可信输入，Firefox 弹窗拦截未开新标签，
  故继承逻辑未被触发。属已声明的 untrusted-input/弹窗边界，**不通过改用户弹窗设置绕过**；
  该代码路径记为 NOT RUN。

## 其它 finding（非断言 FAIL，但需记录）

- `page.back` 响应的 `pageInfo.url` 仍指向返回前的 URL（`?history=next`）；返回后 `page.url()` 正确，
  仅响应元数据过期。已交 **Codex** 修复；复验时 `back.json.data.pageInfo.url` 必须等于
  `page.url()`（harness 已把该项从 finding 收紧为必需断言）。

## 复验关注项（来自协调者静态审查，基线未覆盖）

1. inject/attach 不得忽略 frame 级 `executeScript.error` 或目标 frame 缺失。
2. frame 路由/注入等待后需有取消检查；resolve 持久化后需有取消检查。
3. `tabs.create` 返回后需在 ctx 保存原生 tabId，避免释放检查被削弱。
4. network 并发 in-flight chunks 未计入 2 MiB 总预算；预算口径为**原始在途字节 + 保留 UTF-8 字节**，
   非 OS 内存上限（owner 补真实预算逻辑）。
5. network response filter 转发应完整；**fixture 必须确认页面 realm 实际收到完整原始大响应与
   UTF-8 内容**，而不只是看采集记录的 truncated flag。6 路有界并发验证接线；in-flight 内存预算
   上限本身仅纯逻辑可证，**不得把黑盒留存字节等同为全部在途内存的证明**。
6. iframe `getBoxQuads` 的严格边界无变换 fallback（平台 owner）：只支持 client/used-border/padding
   可精确证明的盒模型；新增 border+padding 正向坐标、遮挡拒绝、`scale/rotate/perspective` 与
   **分数几何**的显式拒绝（正负边界均记录，不为压低 FAIL 改正向 fixture）。
7. console bridge `original.apply(pageView.console, args)`（平台 owner）；页面继续执行与无 length 越权错误
   均为必需断言。
8. open shadow DOM：**复合跨 shadow CSS 本轮明确不交付**（native CSS 每 root 内匹配，跨 host 用链式或
   role/label/text），最终报告单列限制、不称已修；**链式必须实际成功**，两者分别断言、分别结论。
9. 非安全 HTTP origin：DOM driver 不得依赖 `view.crypto.randomUUID`，改用 `getRandomValues`。
10. `page.back` 响应 `pageInfo.url` 需等于已完成导航的 URL（Codex）。
11. 导航链（Codex 已返修）：主文档 commit 后用 `meta refresh` / `location.replace` 跳转，
    `page.navigate` 必须跟随并返回**真实最终** `pageInfo.url`（与 `page.url()` 一致）；load 回调里
    `history.replaceState` 或 hash 变化必须能 settle，不能等一个已触发的 load；补充同文档 fragment
    与 back 常规案例。新增 `navigation-chain` area 覆盖。
12. 真实取消（新增 `cancellation` area）：自有 fixture 计数器按钮（初值用 `Number.isFinite` 校验，
    读失败即阻断该 area 不起动作）；发 `page.execute` 等待 ~1500ms 后点击，约 250ms 后用**同
    session/requestId** 发 `request.cancel`。断言：`request.cancel` 返回 **`ok:true`**（非仅 body 非空）；
    被取消的 execute 必须 **`ok:false` 且 `error.code==='cancelled'`**（outcome 可为 unknown），**其它
    typed error 不当作取消 PASS**；超过原等待（2000ms）后计数**未变化**；再做一次不取消的正常点击作
    正向对照。仅验证「真实取消后不迟发该动作」，**不宣称复现 frame 注入竞态**；拿不到结构化取消结果
    （传输 abort / 独立 worker 阻断）时记 SKIP/NOT RUN，不用 mock/不开权限。
13. 瞬时新标签注入竞态（create 期间 about:blank/文档切换）：无可可靠构造的真实触发前记为 **NOT RUN**，
    不用 API 替身冒充。

## 本轮变更（2026-09-13 后续，仅离线测试/报告）

- harness 新增 `iframe-geometry`、`network-filter` 两个 area；`page.back` 响应 URL 收紧为必需断言；
  shadow 复合改为 SKIP + limitation（链式仍为必需断言）；network 增加**页面 realm 完整性**断言。
- 移除 harness 内的解释性/分隔注释，说明统一放在本报告与 README；**代码行为不变**（仅 `node --check`，
  未跑浏览器）。
- 时限统一：删除 8000ms 分支，截图与 cleanup 也使用**请求 3000 / HTTP 5000** grace；**每个请求/等待
  仍 <=5s**。若未来真实操作慢到超时，如实报告，不放宽时限。
- `PI_BROWSER_RUNTIME_URL`、`PI_FIREFOX_EXPECT_VERSION` 改为**显式必填**（不再把当前测试端口/版本写成
  隐式默认）；缺失时在任何浏览器动作前清楚退出；README 已同步。
- 依据：协调者要求暂停真实浏览器动作，只完善测试/报告，等通知新版本加载后再复验。最终复验时由协调者
  明确提供 19991 与新版号。
- 追加 `navigation-chain` area（Codex 导航链返修的最终复验）：meta refresh / location.replace 跟随到
  最终文档并核对 `pageInfo.url` 与 `page.url()`；load 回调 replaceState / hash 变化需能 settle；
  同文档 fragment 与 back 常规案例。仍只用自带 fixture 与稳定 ID，未运行。
- 追加 `cancellation` area（真实取消，非 frame 注入竞态复现）：fixture 计数器 + 延迟点击 + 同
  session/requestId 的 `request.cancel`；断言结构化取消结果、超时后计数不变、正常点击正向对照。
  请求/传输仍 <=5s。未运行。

## 范围与限制

- 只验证本 harness 的本地无敏感数据 fixture；未测试任何用户真实业务站点。
- 未运行 runtime unit/integration（由协调者串行）；未触碰 19989。
- 未修改 Firefox 权限/设置、未开启 userScripts/远程调试、未重载扩展、未启动额外浏览器。
- 日志/证据只写本 worktree `tmp/`；未记录 token/ticket/cookie/私钥。
- 本报告不代表全部 Gecko 浏览器、全部站点或与 Chrome 全面对等。
