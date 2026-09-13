# Firefox 0.0.137 最终实机验收报告

日期：2026-09-13。分支 `test/firefox-swarm-acceptance`，基线 `5e20451`（本分支起点）。
角色：全新、独立的最终实机验收者，**只修改/运行 harness、fixture、证据与报告，未改动任何产品源码**。

Harness：`acceptance/firefox-swarm/firefox-swarm-acceptance.mjs`（本次为修正 harness 自伤做了改动，见「harness 自我修正」）
主证据（完整含 96s idle）：`tmp/firefox-swarm-acceptance/evidence-2026-09-13T04-18-13-683Z/`（`evidence.json` + `report.md`）
运行日志：`tmp/firefox-swarm-acceptance/full-0.0.137-20260913T041813Z.log`

## 结论

**完整实机运行：PASS 114 / FAIL 6 / SKIP 2（+2 findings），预检未阻断。**
真实加载版本为 **0.0.137**（`/extensions/status` 实测，非源码/离线结果）。

- 与 0.0.136 基线（原始 **77 PASS / 8 FAIL / 1 SKIP**）相比，本轮多项已声明能力**真实修复并通过**：
  iframe 同/跨源动作、iframe 无变换几何 + 变换/分数几何显式拒绝、console 后页面继续执行且无越权错误、
  非安全 HTTP origin 的 DOM driver、`page.back` 响应 URL、显式链式 shadow locator。
- 仍有 **4 项 navigation-chain 稳定 FAIL**（4 次运行全部复现）与 **1 项偶发 snapshot-ref FAIL**（4 次运行中 1 次）。
  这些是**实际 Firefox 运行结果**，不是离线结论；不能据此宣称 Firefox 与 Chrome 对等，也不能把预检未阻断写成产品无阻断。
- 复合跨 shadow CSS 仍为**本轮明确不交付**（SKIP + limitation，不称已修）；显式链式已 PASS。
  `target=_blank` 的 `sourceTabId` 仍受 DOM 不可信点击/弹窗拦截边界限制（SKIP，不绕过用户设置）。

## 实测环境

| 项 | 值 |
| --- | --- |
| runtime | `http://127.0.0.1:19991`（`19989` 日常 Chrome 未触碰） |
| 扩展版本 | `0.0.137`（`/extensions/status`） |
| connected Firefox profile | 恰好 1 个：`profile-9d78fcf9-0241-47d2-b73f-ea9793ea4072` |
| connectionId | `mtzap2md_q3to5z`（本次实测；与协调者所给 `mtzaa0es_7qcybq` **不同**） |
| browserEpoch | `epoch-34889599-b966-4992-8303-5b5c9b0d6824`（与协调者所给 `epoch-17b9653e-…` **不同**） |
| capabilities | `webextension` / `dom` / `dom-aria` / `dom-compatible` / `isolated` |
| 验收 session | 每次运行独立 `crypto.randomUUID()`（隔离检查另用第二个 session） |
| fixture | 本前台进程内两台 `127.0.0.1` 随机端口 HTTP 服务，`finally` 关闭 |

> **连接标识漂移说明**：profileId 与版本与协调者一致，且实测期间（3 次采样、每次间隔 3s）稳定为唯一 connected；
> 但 extension 连接 ID 与 browserEpoch 与协调者快照不同，说明扩展在协调者查询之后**重新连接/新运行期**过。
> 版本与唯一 connected 这两项硬前置满足、无目标歧义，故未阻断；此漂移如实记录。96s idle 采样期间
> `connectionId`/`epoch`/版本/connected 全程不变（25 次采样）。

预检：唯一 connected Firefox profile、版本 `0.0.137`、扩展状态按 `stableKey` 1:1 映射到该 profile；否则阻断退出。

## 通过的关键能力（0.0.137 相对 0.0.136 的真实修复）

- **iframe**：同源 `frameLocator(...).fill`、跨源 `frameLocator(...).fill` 均实际成功（0.0.136 为 `getBoxQuads` 拒绝）。
- **iframe-geometry（正负边界）**：带 border+padding 的无变换 frame 点击命中目标；`scale/rotate/perspective`、
  分数几何、父层遮挡三项均**显式 `unsupported-capability` 拒绝**，未做包围盒近似。
- **console**：`console.log` 后页面继续执行（`#event-log` 追加），且普通 console 调用**不再**产生
  `Permission denied to access property "length"` 越权错误。
- **非安全 HTTP origin**：`http://localtest.me:<port>/`（页面 realm `isSecureContext=false`、`crypto.randomUUID=undefined`）
  的 `page.snapshot` 与 locator 读取均成功（0.0.136 为 `invalid result`）。
- **导航**：`page.navigate` 到 `?history=next` 与随后 `page.back` 均真实改变 URL，且 `page.back` 响应
  `pageInfo.url` == 返回后 `page.url()`（0.0.136 响应 URL 过期）。
- **同文档 fragment**：`#section2` navigate 与随后 back 的返回/实际 URL 一致。
- **network-filter**：6 路并发页面 fetch、页面 realm 完整 UTF-8 正文、3 MiB 大响应在页面 realm 的字符/字节/tail
  完全正确（读页面 DOM，非只看采集记录）、采集记录有界/显式截断、stop 保留旧行、stop→restart 后新请求被采集。
- **release/隔离/cleanup**：release 后拒绝控制；第二 session 看不到/操作不了第一 session 的组与标签；
  被 release 的物理标签 discover+attach 重新接管后可关闭；自建组/标签全部清理，`tabs.discover` 无 fixture 残留。
- 其余 snapshot/ref、role 表单、hidden 过滤、chained shadow、截图、logs 捕获、execute 读取、
  未授权 `userScripts` 的显式拒绝、locator 严格性、真实取消后不迟发（含正向对照）等均 PASS。

## FAIL（执行过、与声明能力不符）

### 1. navigation-chain：`meta refresh` 后 `page.navigate` 未返回真实最终 URL（4/4 稳定）

| 项 | 内容 |
| --- | --- |
| 期望 | `page.navigate` 跟随 `<meta http-equiv="refresh">` 到 `/nav/final.html?via=meta` 并返回该最终 `pageInfo.url` |
| 实际 | `ok:false`，`outcome-unknown`：`Firefox navigation was observed, but the current main frame and tab metadata do not match its completion; the action will not be replayed.`（1/4 次为 `execution-failed`，`Error code 2152398850`） |
| 最小复现 | `page.navigate` 到 `/nav/meta-refresh.html`；紧跟的 `return page.url()` 显示页面**已到** `?via=meta`（即导航已完成），但 navigate 响应未给出最终 URL |
| 证据 | `evidence-2026-09-13T04-18-13-683Z/evidence.json` → result `navigation-chain :: page.navigate follows a meta-refresh redirect…`；请求见同文件 `requests` |

### 2. navigation-chain：`location.replace` 后 `page.navigate` 未返回真实最终 URL（4/4 稳定）

| 项 | 内容 |
| --- | --- |
| 期望 | 跟随 `location.replace('/nav/final.html?via=location')` 并返回最终 URL |
| 实际 | `ok:false`，`execution-failed`：`Error code 2152398850`（= `0x804B0002`，Gecko `NS_BINDING_ABORTED`） |
| 最小复现 | `page.navigate` 到 `/nav/location-replace.html`（该页 `location.replace` 打断原导航）；随后 `page.url()` 已到 `/nav/final.html?via=location` |
| 说明 | 这一 abort 在契约里应被识别为「旧导航被替换」并过滤，实际未过滤 |
| 证据 | 同上 evidence → `navigation-chain :: page.navigate follows a location-replace redirect…` |

### 3. navigation-chain：load 期 `history.replaceState` 后未 settle（4/4 稳定）

| 项 | 内容 |
| --- | --- |
| 期望 | `page.navigate` 在 load 回调 `history.replaceState(null,'','/nav/replace-state.html?replaced=1')` 后 settle 并返回 `?replaced=1` |
| 实际 | `ok:false`，`outcome-unknown`（同 #1 文案） |
| 最小复现 | `page.navigate` 到 `/nav/replace-state.html`；随后 `page.url()` 已为 `?replaced=1` |
| 证据 | 同上 evidence → `navigation-chain :: page.navigate settles after history.replaceState on load` |

### 4. navigation-chain：load 期 `location.hash` 变化后未 settle（4/4 稳定）

| 项 | 内容 |
| --- | --- |
| 期望 | `page.navigate` 在 load 回调 `location.hash='#frag'` 后 settle 并返回 `#frag` |
| 实际 | `ok:false`，`outcome-unknown`（同 #1 文案） |
| 最小复现 | `page.navigate` 到 `/nav/hash-change.html`；随后 `page.url()` 已为 `#frag` |
| 证据 | 同上 evidence → `navigation-chain :: page.navigate settles after a load-time hash change` |

> 附：fast pass 第 3 次运行（`evidence-2026-09-13T04-17-13-668Z`）中，meta-refresh navigate 失败后**紧跟的**
> `page.execute` 偶发返回 `Firefox page.execute: Missing host permission for the tab`（`execution-failed`），
> 使 `final document really loaded for the meta-refresh redirect` 也 FAIL（4 次运行中 1 次）。属同一导航观测/@注入时序问题的另一症状。

### 5. snapshot-ref：新建标签后按 ref `page.fill` 偶发 `stale-snapshot`（1/4，定向诊断未复现）

| 项 | 内容 |
| --- | --- |
| 期望 | `page.snapshot` 返回的 ref（本例 `aria-ref=e10`，name `Controlled name`）+ 其 `snapshotId` 可 `page.fill` 成功，DOM value 变为 `RefAlice` |
| 实际 | `page.fill` 返回 `ok:false`，**原始 error**：`code:"stale-snapshot"`，`message:"Snapshot ref aria-ref=e10 is missing or stale. Take a fresh snapshot and pass its snapshotId with a ref shown in that snapshot."`，`outcome:"not-started"`；DOM value 仍为 `Alice`，连带 `DOM value reflects the ref-based fill` FAIL |
| 最小复现 | 新建 fixture 标签 → `waitForTabUrl` 等到目标 URL → 取一次 `page.snapshot`（本次实测该请求耗时 1118ms）→ 40ms 后按该 ref `page.fill`；`snapshotId` 被判 stale |
| 观测窗口已知量 | 仅：URL 已 settle、snapshot 耗时 1118ms、随后 fill 40ms 返 stale；`page.fill` 请求见 raw requests。**当时没有 MutationObserver/文档更替观测**，故**不能**断言“DOM 未变”或“就是注入竞态” |
| 说明 | 4 次运行中 1 次（仅完整运行命中）。定向诊断（见下节）在 6 种条件下共 18 个固定样本**未复现** stale（0/18），既未观察到“无变化的误失效”，也未观察到“真实变化导致失效”。因此根因**未定**，需产品 owner 用更可观测的手段定性；**未改 harness 去掩盖，未加 retry，未削弱产品 stale 校验，也未降级为 SKIP** |
| 证据 | `evidence-2026-09-13T04-18-13-683Z/evidence.json` → results `snapshot-ref :: page.fill by snapshot ref succeeds`、`… DOM value reflects the ref-based fill`；原始请求 `requestId dc0c166a-…`（`page.fill`，error.code=`stale-snapshot`）、`requestId d6b3b7c0-…`（随后的 stale ref click） |

> 口径订正：本报告前一版把该 FAIL 的 `actual` 记成 `null`，是因为 harness 在该断言里误用 `fillByRef.error`（send 结果里错误在
> `fillByRef.json.error`），已修正为 `.json?.error`（同处 `snap.error`、`attempt.error` 一并修正），并已把原始
> `stale-snapshot` message 带进 results/report。该修正只改 `actual` 文本，不改判定逻辑。

## SKIP / 未交付限制（不称已修）

- **复合跨 shadow CSS**（`page.locator('#shadow-host input')`）：本轮**明确不交付**（native CSS 每个 document/shadow root 内匹配，
  跨 host 用显式链式或 role/label/text）。记为 SKIP + limitation finding，不称已修；显式链式
  `page.locator('#shadow-host').locator('input')` 本轮**实际 PASS**（两者独立断言、独立结论）。
- **`target=_blank` 的 `sourceTabId`**：DOM 点击为不可信输入，Firefox 弹窗拦截未开新标签，
  继承逻辑未被触发（NOT RUN）。属已声明的 untrusted-input/弹窗边界，**不通过改用户弹窗/权限设置绕过**。
- 未启用任何 Firefox 权限（`userScripts` 保持 unsupported 并被显式断言拒绝），未开远程调试/Inspector 保活，
  未重载扩展、未改 Firefox 设置/权限/hosts/DNS，未启动额外浏览器。

## harness 自我修正（根因、保留原始结果）

所有修正仅限 harness/fixture，产品源码未动。**原始 fast pass 证据已保留**：
`evidence-2026-09-13T04-12-29-969Z`（修正前，104 PASS / 14 FAIL / 3 SKIP，日志 `fastpass-20260913T041229Z.log`）。

1. **network-filter 误用浏览器 `fetch`（根因，harness 缺陷）**
   原始 FAIL：`Firefox page.execute: fetch is not defined`（连带 8 项 FAIL）。
   根因：`page.execute` 运行在 runtime 的 **Node `vm` 隔离沙箱**。该 realm 以参数/shim 形式提供
   `page`/`context`/`state`/`console`/`Buffer`/`TextEncoder`/`TextDecoder`/`URL`/`URLSearchParams`/`atob`/`btoa`/
   `crypto.randomUUID`/`setTimeout`/`setInterval`/`process`（见 `firefox-executor-realm.ts`）。**缺的是浏览器网络全局
   `fetch`**（以及 `window`/`document`——它们来自需要可选 userScripts 权限的 `page.evaluate`）；**不是**“所有浏览器全局都缺”，
   `TextEncoder`/`TextDecoder`/`URL` 恰恰是可用的。原 harness 在 execute 里调 `fetch` 属错误假设，非产品缺陷。
   修正：由 **fixture 页面自身**发起 fetch 并把页面 realm 结果（字符数、字节数、精确文本/tail）写入 DOM，
   harness 用 DOM 点击触发、再读回 DOM 校验。这样仍是**页面 realm 真实收包**的证明，且符合契约。
2. **shadow-dom 被 iframe 遮挡（根因，harness 缺陷）**
   原始 FAIL：`Firefox page.execute: The selected element is covered by <iframe>.`
   根因：fixture 把带 `transform: scale(1.3) rotate(7deg)` 的 `#scaled-frame` 放在 `#shadow-host` 紧邻前方，
   该 frame 的变换溢出在视觉上盖住 shadow input；产品在 `firefox-dom-input.ts` 用 `elementFromPoint` 判定遮挡并**正确拒绝**
   （等价于真实用户点击会命中 iframe）。属 fixture 自伤。
   修正：把 `#shadow-host` 移到 iframe 之前，使 shadow 与 frame 断言互不影响；**未削弱任何 iframe-geometry 正向 fixture**。
3. **network stop/restart 断言与契约冲突（harness 过严）**
   原始 FAIL：重启后要求先前 6 行 echo 仍在。
   根因：契约（`pi/skills/SKILL.md`）明确「later explicit `start` replaces the previous capture」；实测
   `stop` 后旧行仍可 list（已单独断言 PASS），显式 `start` 按契约替换并报告 `retainedCount`/`droppedCount`。
   修正：新增「`stop` 保留旧行」断言；把重启后的断言改为「重启被报告为契约化替换、非静默丢失」。
   这是产品**符合契约**的行为，不是把产品问题降 SKIP。
4. **失败 `actual` 丢原始 error（harness 口径缺陷）**
   `snapshot-ref` 的 fill 校验把错误读成 `fillByRef.error`，而 send 结果里错误在 `fillByRef.json.error`，导致 `actual` 为 `null`
   （原始 requests 里确有 `stale-snapshot`）。已改为 `.json?.error`（同类 `snap.error`、`attempt.error` 一并修正），只影响 `actual` 文本，不改判定逻辑。

**为一致性/可复现补充（不影响判定）**：新增定向诊断脚本 `acceptance/firefox-swarm/snapshot-ref-diagnosis.mjs`；README 同步执行沙箱与 fixture 布局说明。

修正后 fast pass：`evidence-2026-09-13T04-15-58-873Z`（113/5/3）、`evidence-2026-09-13T04-17-13-668Z`（114/5/3）。
除上述 navigation-chain 与偶发 snapshot-ref 外，其余全部 PASS。

## snapshot-ref 定向诊断（固定样本，0/18 stale，根因未定）

目的：在**不改产品**的前提下，区分“真实文档/DOM 变化导致（正确防护）”与“无变化的误失效”，并检查是否需要修 harness 前置条件。
脚本：`acceptance/firefox-swarm/snapshot-ref-diagnosis.mjs`（只创建/清理自己的 session/group/tab；fixture 前台 bind 随机端口并在 `finally` 关闭）。
原始证据：`tmp/firefox-swarm-acceptance/snapshot-ref-diagnosis-2026-09-13T04-38-27-096Z/`（复刻 complex，12 样本）、
`…/snapshot-ref-diagnosis-2026-09-13T04-39-27-726Z/`（真实 harness index，6 样本）。

设计（无 retry-until-pass，每条件固定 3 次）：

| 维度 | 取值 |
| --- | --- |
| fixture | `static`：无 iframe、无异步 DOM 的最小页；`complex`：harness 帧/shadow 结构的复刻；`real`：**直接提取 harness 真实 `index.html`**（含 5 个同源 iframe、1 个跨源 iframe、open shadow） |
| 就绪条件 | `url`：`tab.resolve` URL settle 后轮询 snapshot 直到出现 `Controlled name`（复刻 harness 原逻辑）；`load`：snapshot **之前**先执行一次 `await page.waitForURL(url); await page.waitForLoadState('load')` |
| 测量 | 就绪后取**被测 snapshot（含其 snapshotId/ref 原值）**，紧接着 `page.fill(aria-ref=…)`；任何额外 execute/snapshot 都在被测 snapshot 之前 |
| 观测 | 每个页面（含每个 frame，含跨源）注入 MutationObserver + load/DOMContentLoaded/pagehide 上报：**只把非敏感 tag/属性名/时间 POST 到 Node fixture server**，测量窗口内不写 DOM，避免自造失效 |

结果：**18/18 样本 `page.fill` 成功，0 次 `stale-snapshot`**。

| 条件 | 样本 | stale | fill ok | 窗口内记录到页面侧事件（见不推断声明） |
| --- | --- | --- | --- | --- |
| static-url | 3 | 0 | 3 | 0 |
| static-load | 3 | 0 | 3 | 1 |
| complex-url（复刻） | 3 | 0 | 3 | 3 |
| complex-load（复刻） | 3 | 0 | 3 | 0 |
| complex-real-url（真实 index） | 3 | 0 | 3 | 3 |
| complex-real-load（真实 index） | 3 | 0 | 3 | 3 |

**窗口定义与不推断声明**：

- 本文的“窗口”= [被测 snapshot 请求发出, `page.fill` 响应返回]；事件时间为 **Node fixture server 的接收时间**，`eventsInWindow` 只表示接收时间落在该区间（`[t0-20ms, t1]`）。
- 窗口内记录的页面侧事件**不等价于**“快照有效期内被观察根发生了真实变化”。它们可能来自：① snapshot 计算期间；② `page.fill` 期间或之后（fill 会触发 fixture 的 `input` 监听，该监听向 `#event-log` 追加以致其自身产生主文档 childList 变更）；③ **当前未被产品 snapshot 观察**的文档（如 snapshot 时 `contentDocument` 尚不可用的同源 iframe、或跨源 iframe）。
- 因此“窗口内有事件”**不能**推出“真实变化但未失效”，也**不能**推出“无变化而误失效”。本诊断**不对**每个事件归属上述哪一类做因果推断，只保留准确计数与时间。

可直接读出的观测（fixture 页面侧，非产品内部）：

- **URL 就绪时，第一次 snapshot 常常还不含目标 ref**（如 static-url #1 首帧 322ms 无 `Controlled name`，第二帧 67ms 才有）；复刻/真实 complex 同样。即 URL settle 早于“文档可快照”，这与被测 snapshot 通常是“轮询后的那一帧”一致。
- 真实 index 的 `complex-real-url` 与 `complex-real-load`：窗口内均记录到主文档 mutation 与若干 iframe 的 init/load；但这些仅为接收时间落在窗口内，按上方声明**不区分**是否由 fill 自身、snapshot 期间或未被观察文档产生。逐事件的接收时间与相对 snapshot 起点的偏移保存在原始 `diagnosis.json`。
- 被测 snapshot 耗时 24–657ms，均未接近失败运行的 1118ms；环境全程 `epoch-34889599-…`/`connectionId=mtzap2md_q3to5z`/`0.0.137` 不变。

结论（不夸大）：**根因未定（UNDETERMINED）**。固定 3 次/条件下的 18 次受控样本未能复现唯一一次 stale，因此无法据此判定它是真实变化引起的正确防护，还是无变化时的误失效。
因此：

- **不修改 harness 前置条件**（无证据表明 `waitForLoadState('load')` 能消除它；也不加 retry）；
- **不削弱产品 stale 校验**；
- 保留原 FAIL 记录与原始 error，交协调者/产品 owner 定性；产品 owner 正在加入**有界 stale 原因诊断（不改拒绝条件）**，
  下一轮若再遇到即可分辨内部原因。可复现入口是完整 harness 的首次 snapshot 路径（4 次完整运行命中 1 次）。

## 复验关注项（本轮实测状态）

1. inject/attach 不得忽略 frame 级 `executeScript.error`：本轮未复现忽略（iframe 读/写均 PASS）。
2. frame 路由/注入等待后的取消检查：未单独构造，NOT RUN。
3. `tabs.create` 保存 native tabId：本轮未复现释放检查被削弱。
4. network 并发在途字节预算：仅纯逻辑可证，黑盒不宣称；本轮页面 realm 大响应完整性 PASS。
5. network 完整转发：本轮 6 路并发 + UTF-8 + 3 MiB 页面 realm 完整性 PASS。
6. iframe 无变换 fallback 正负边界：本轮全部 PASS（border+padding 正向；变换/分数/遮挡显式拒绝）。
7. console bridge：本轮「页面继续执行 + 无 length 越权错误」均 PASS。
8. open shadow DOM：显式链式 PASS；复合跨 shadow CSS 本轮不交付（SKIP，不称已修）。
9. 非安全 HTTP origin：本轮 snapshot/读取 PASS。
10. `page.back` 响应 URL：本轮与完成导航 URL 一致，PASS。
11. 导航链（meta refresh / location.replace / replaceState / hash）：**本轮仍 FAIL**（见 FAIL #1–#4）。
12. 真实取消后不迟发：本轮结构化取消 + 计数不变 + 正向对照全部 PASS（不宣称复现 frame 注入竞态）。
13. 瞬时新标签注入竞态（create 期间 about:blank/文档切换）：完整运行命中 1 次（snapshot-ref 偶发 `stale-snapshot`，FAIL #5）；
    随后按固定样本定向诊断 18 次**未复现**（见上节）。**根因未定**：不能据此称“已证实为注入竞态”，也不能称“误失效”；
    窗口内的事件不作为推断依据（见上节「不推断声明」）。留待 owner 定性；产品 owner 正在加入**有界 stale 原因诊断（不改拒绝条件）**，
    下一轮若再遇到即可分辨内部原因。

## 范围与限制

- 只验证本 harness 的本地无敏感数据 fixture；未测试任何用户真实业务站点，未接管/导航/关闭用户既有页面。
- 只操作本次新 UUID session 下新建的 fixture/group/tab，按稳定 native/logical ID 清理；清理全部通过，
  `tabs.discover` 复核无 fixture 物理标签残留。
- 未运行 runtime unit/integration（由协调者串行）；未触碰 `19989`。
- 日志/证据只写本 worktree `tmp/`；未输出 token/ticket/cookie/私钥。
- 本报告不代表全部 Gecko 浏览器、全部站点或与 Chrome 全面对等。
