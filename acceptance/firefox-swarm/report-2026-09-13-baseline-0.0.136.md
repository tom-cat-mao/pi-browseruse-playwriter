# Firefox swarm independent acceptance — 0.0.136 baseline

日期：2026-09-13。分支 `test/firefox-swarm-acceptance`，基线 `f963175`（0.0.136）。
角色：独立验收 owner，只编写/运行验收 harness、fixture、证据与报告，未修改任何产品源码。

Harness：`acceptance/firefox-swarm/firefox-swarm-acceptance.mjs`
原始证据：`tmp/firefox-swarm-acceptance/evidence-2026-09-12T17-33-17-346Z/`（`evidence.json` + `report.md`）

## 结论

**PASS 77 / FAIL 8 / SKIP 1（+9 findings）**。基线可运行、可清理，但发现 8 项与已声明能力不符的
真实 Firefox 运行问题，其中 5 类已由平台 owner 接手。**不能宣称 Firefox 与 Chrome 对等。**

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

| # | 区域 | 期望 | 实际 | 最小复现 |
| --- | --- | --- | --- | --- |
| 1 | shadow-dom | 复合 `#shadow-host input` 应遍历 open shadow root | `count=0` | `page.locator('#shadow-host input').count()` |
| 2 | shadow-dom | 链式 `page.locator('#shadow-host').locator('input')` 应进入 host 的 shadowRoot | `count=0`（非等待型 count，排除自造超时） | `page.locator('#shadow-host').locator('input').count()` |
| 3 | iframe 同源 | 指南声明 frameLocator 动作可用；读已 PASS | `unsupported-capability`：`Firefox getBoxQuads is required to verify the frame content box` | `page.frameLocator('#local-frame').locator('#frame-input').fill('Frame v2')` |
| 4 | iframe 跨源 | 同上 | 同一 `getBoxQuads` 拒绝 | `page.frameLocator('#cross-frame').locator('#xo-input').fill('Cross v2')` |
| 5 | logs | `console.log` 后页面能继续执行 | 页面 `#event-log` **未追加** `page console.log emitted`，即页面 realm 的 `console.log` 抛错 | 点击按钮执行 `console.log('x'); eventLog += 'appended'` |
| 6 | logs | 捕获一条普通 `console.log` 不应产生额外页面错误 | 每次 console 调用额外产生 `[error] Error: Permission denied to access property "length"`，位置指向页面调用点 | `console.log('plain string')` 后 `page.logs`（log/warn/error 与对象/Error 参数均可复现） |
| 7 | insecure-context | 普通 http 页面 snapshot 应可用 | `execution-failed`：`Firefox content script returned an invalid result` | 受控标签打开 `http://localtest.me:<port>/`（页面 realm `isSecureContext=false`、`crypto.randomUUID` 为 `undefined`，经浏览器标题 API 独立读取）后 `page.snapshot` |
| 8 | insecure-context | 普通 http 页面 locator 读取应可用 | 同 7 的 `invalid result` | 同源 `page.locator('#probe-heading').textContent()` |

FAIL 3/4 与 5/6 已分别由平台 owner 接手（iframe 严格边界、无变换的 frame fallback；console bridge
`firefox-dom.ts original.apply(pageView.console, args)`）。FAIL 7/8 与 owner 的
`view.crypto.randomUUID`（SecureContext）假设一致，**证据为高置信运行期对照，但不是内容脚本
堆栈级根因**，修复尚未集成，故不宣称 P1 已定案。FAIL 1/2 为 locator 遍历缺口（role/label 路径正常）。

## SKIP（真实未执行 / 明确文档限制）

- `target=_blank` 的 `sourceTabId`：DOM 点击是非可信输入，Firefox 弹窗拦截未开新标签，
  故继承逻辑未被触发。属已声明的 untrusted-input/弹窗边界，**不通过改用户弹窗设置绕过**；
  该代码路径记为 NOT RUN。

## 其它 finding（非断言 FAIL，但需记录）

- `page.back` 响应的 `pageInfo.url` 仍指向返回前的 URL（`?history=next`）；返回后 `page.url()` 正确，
  仅响应元数据过期。

## 复验关注项（来自协调者静态审查，基线未覆盖）

1. inject/attach 不得忽略 frame 级 `executeScript.error` 或目标 frame 缺失。
2. frame 路由/注入等待后需有取消检查；resolve 持久化后需有取消检查。
3. `tabs.create` 返回后需在 ctx 保存原生 tabId，避免释放检查被削弱。
4. network 并发 in-flight chunks 未计入 2 MiB 总预算（owner 补真实预算逻辑）。
5. iframe `getBoxQuads` 的严格边界无变换 fallback（平台 owner）。
6. console bridge `original.apply(pageView.console, args)`（平台 owner）。
7. open shadow DOM：复合与链式 locator 需遍历 root shadowRoot。
8. 非安全 HTTP origin：DOM driver 不得依赖 `view.crypto.randomUUID`，改用 `getRandomValues`。
9. 瞬时新标签注入竞态（create 期间 about:blank/文档切换）：无可可靠构造的真实触发前记为 **NOT RUN**，
   不用 API 替身冒充。

## 范围与限制

- 只验证本 harness 的本地无敏感数据 fixture；未测试任何用户真实业务站点。
- 未运行 runtime unit/integration（由协调者串行）；未触碰 19989。
- 未修改 Firefox 权限/设置、未开启 userScripts/远程调试、未重载扩展、未启动额外浏览器。
- 日志/证据只写本 worktree `tmp/`；未记录 token/ticket/cookie/私钥。
- 本报告不代表全部 Gecko 浏览器、全部站点或与 Chrome 全面对等。
