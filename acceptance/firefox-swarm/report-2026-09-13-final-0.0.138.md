# Firefox 0.0.138 最终实机验收报告

日期：2026-09-13。分支 `test/firefox-swarm-acceptance`，HEAD `78c4568`（含上一轮全部工作与离线补的
active→start 网络用例）。角色：独立实机验收 owner，**只运行 harness、写证据与报告，未改动任何产品源码、
未改 harness 判定逻辑、未加 retry、未削弱任何校验**。

- Harness：`acceptance/firefox-swarm/firefox-swarm-acceptance.mjs`（全矩阵，含 online 的 active→start 用例）
- 定向诊断：`acceptance/firefox-swarm/snapshot-ref-diagnosis.mjs`（未改动）
- 运行方式：`PI_BROWSER_RUNTIME_URL=http://127.0.0.1:19991 PI_FIREFOX_EXPECT_VERSION=0.0.138`

## 结论

**完整实机运行：PASS 126 / FAIL 0 / SKIP 2（+2 findings），预检未阻断。**

真实加载版本为 **0.0.138**（`/extensions/status` 实测，非源码/离线结果）。
上一轮 0.0.137 的 6 项 FAIL 中：**4 项 navigation-chain 稳定 FAIL 与偶发 snapshot-ref FAIL 本轮全部转 PASS**。
剩余 2 项 SKIP 均为既定边界（跨 shadow 复合 CSS、`target=_blank` sourceTabId），非产品失败。
**所有非边界项均 PASS，故本报告结论为 PASS。**

## 实测环境

| 项 | 值 |
| --- | --- |
| runtime | `http://127.0.0.1:19991`（`19989` 日常 Chrome 未触碰） |
| 扩展版本 | `0.0.138`（`/extensions/status` 实测） |
| connected Firefox profile | 恰好 1 个：`profile-21e32b35-9a0d-4617-9082-372447f6a7b0` |
| connectionId | `mtzh3hqq_4tm61y` |
| browserEpoch | `epoch-19343486-c0ab-43ea-bbb9-2142ab935722` |
| capabilities | `webextension` / `dom` / `dom-aria` / `dom-compatible` / `isolated` |
| 验收 session | 每次运行独立 `crypto.randomUUID()`（隔离检查另用第二个 session） |
| fixture | 本前台进程内两台 `127.0.0.1` 随机端口 HTTP 服务，`finally` 关闭 |
| 全矩阵耗时 | 2m24s（含 96s idle 采样） |

预检：唯一 connected Firefox profile、版本 `0.0.138`、扩展状态按 `stableKey` 1:1 映射到该 profile、capabilities 匹配；
全部通过，未阻断。另独立复核 `tabs.discover` 共 141 个候选，**无任何 `127.0.0.1` fixture 残留**
（`about:debugging` / `about:config` 为用户自身标签，非本次创建）。

## 上一轮集成项的本轮实测

| 集成项 | 上一轮状态 | 本轮实测 |
| --- | --- | --- |
| 导航修复（完成候选可更新 + 两次事实一致核对 + 仅精确 `NS_BINDING_ABORTED` 暂存且需替代证据） | 4 项 navigation-chain 稳定 FAIL / `Error code 2152398850` | **全部 PASS**，见下节 |
| stale-ref 有界原因诊断（不改拒绝条件） | 偶发 `stale-snapshot`，根因 UNDETERMINED | 首帧 fill **未复现**；定向诊断 0/18 stale；拒绝路径携带 `reason` |
| active network start 无条件替换旧 capture 契约校正 | 未覆盖 | **PASS**（active→start 用例） |
| 离线补的 active→start 网络用例 | 仅在 harness 内 | **真实运行 PASS** |

## 重点定向复核

### 1. 四项 navigation-chain（+ 同文档 fragment / back）全部转 PASS

`page.navigate` 均返回真实最终 `pageInfo.url`，且紧跟的 `page.url()` 一致：

| 用例 | 期望最终 URL | `page.navigate` 响应 `pageInfo.url` | 结果 |
| --- | --- | --- | --- |
| meta refresh | `/nav/final.html?via=meta` | `http://127.0.0.1:63136/nav/final.html?via=meta` | PASS |
| location.replace | `/nav/final.html?via=location` | `…/nav/final.html?via=location` | PASS |
| load 期 history.replaceState | `/nav/replace-state.html?replaced=1` | `…/nav/replace-state.html?replaced=1` | PASS |
| load 期 location.hash | `/nav/hash-change.html#frag` | `…/nav/hash-change.html#frag` | PASS |
| 同文档 fragment | `…/nav/hash-target.html#section2` | `…/nav/hash-target.html#section2` | PASS |

- 4 次导航请求原始记录均 `ok:true`：meta 355ms、location-replace 341ms、replaceState 186ms、hash-change 222ms；
  后续 `page.execute(return page.url())` 也逐条 `ok:true`（71/68/54/56ms），文档确实到达最终 URL。
- 上一轮的 `outcome-unknown` 与 `Error code 2152398850`（`0x804B0002` / `NS_BINDING_ABORTED`）**本轮均未出现**。
- 附带 PASS：`page.back` 响应 URL 与完成导航一致；同文档 fragment 与随后 back 的返回/实际 URL 一致。

### 2. stale-ref：首帧 fill 未复现；定向诊断 0/18

- **全矩阵**（权威路径）：新建标签 → 等到目标 URL → 轮询 `page.snapshot` 直到出现 `Controlled name` →
  `page.fill(aria-ref=e10, snapshotId=firefox:33a0bde2-3b4…)` **`ok:true`（56ms）**，DOM `#controlled-name`
  变为 `RefAlice`（对应 2 项断言 PASS）。上一轮命中该路径的偶发 `stale-snapshot`（1118ms snapshot 后 40ms fill）**未复现**。
- **有界 stale 原因诊断已生效并可见**：同一轮里**故意**复用旧 ref 的负向用例
  `page.click(aria-ref=e10, snapshotId=…)` 返回 `code:"stale-snapshot"`，且携带
  **`reason:"invalidated:action"`** —— 拒绝条件与上一轮一致，只是现在给出了内部原因。
- **定向诊断**（未改动脚本，6 条件 × 固定 3 次 = 18 样本）：
  **0 次 `stale-snapshot`，`staleSummary` 为空**。其中 17 个样本 fill `ok`。
  第 18 个样本 `complex-load #1` 未测到（fill skipped）：其就绪 `page.execute` 与随后的 `page.snapshot` 均在
  44–45ms 内被 `unsupported-capability`（`Firefox extensions cannot control this URL… privileged browser/Mozilla pages`）
  拒绝，即取样瞬间该标签仍在 `about:blank` 过渡态，属**诊断脚本 load 路径的就绪竞态**（脚本在离开
  `about:blank` 前即执行），**既非 stale 也非产品缺陷**；全矩阵权威路径不受影响（它先等到目标 URL 再取样）。
  - 该现象**不改 harness 前置条件、不加 retry、不掩盖**：如实记录，不把它算作产品 PASS 的一部分，也不把它降级为产品 SKIP。
  - 结论：0.0.138 上 `page.fill` 按 snapshot ref 成功；无 0.0.137 那种偶发 `stale-snapshot`。

### 3. active→start（网络 capture 契约校正）PASS

`page.network action=start` 在 capture 已 active 时再次显式 start（新 requestId、filter=`/api/`）：
返回新的 `captureId` 且与旧 id 不同、状态 `active`；替换后旧行**未**被携带（新 capture 起始为空）；
随后匹配 `/api/` 的请求被采集（含 UTF-8 与 3 MiB 大响应，均在页面 realm 校验完整），
非匹配的 `?capture=fixture` 请求与上一 capture 的行**均不存在**。全部 PASS。

## SKIP（仅限既定边界，不是产品失败）

- **跨 shadow 复合 CSS**（`page.locator('#shadow-host input')`）：本轮明确不交付（native CSS 在每个
  document/shadow root 内匹配）；记为 SKIP + finding。独立的显式链式
  `page.locator('#shadow-host').locator('input')` **实际 PASS**（两者独立断言/结论）。
- **`target=_blank` 的 `sourceTabId`**：DOM 点击为不可信输入，Firefox 弹窗拦截未开新标签，继承逻辑未被触发
  （NOT RUN）。属已声明的 untrusted-input/弹窗边界，**不通过改用户弹窗/权限设置绕过**。
- 未启用任何 Firefox 权限（`userScripts` 保持 unsupported 并被显式断言拒绝），未开远程调试、未重载扩展、
  未改 Firefox 设置/权限/hosts/DNS，未启动额外浏览器，未触碰 `19989`。

## 清理与残留

- 全矩阵 cleanup：`no live owned tabs remain after cleanup` PASS；`no fixture-created physical tabs remain in the
  browser` PASS（浏览器真值 `tabs.discover`）。
- 定向诊断 cleanup：自建 group/tab 全部 `ok:true` 关闭；`leftoverFixtures: []`。
- 独立收尾 `tabs.discover`：`ok:true`，141 候选，`127.0.0.1` fixture 残留 **0**。
- 仅操作本次新 session 下新建的 fixture/group/tab；未导航/关闭/接管用户既有页面。

## 证据

| 内容 | 路径 |
| --- | --- |
| 全矩阵证据（含 128 results、requests、samples、cleanup、截图） | `tmp/firefox-swarm-acceptance/evidence-2026-09-13T10-26-52-322Z/`（`evidence.json`、`report.md`、2×PNG） |
| 全矩阵运行日志 | `tmp/firefox-swarm-acceptance/full-0.0.138-2026-09-13T10-26-52Z.log` |
| 定向诊断原始证据 | `tmp/firefox-swarm-acceptance/snapshot-ref-diagnosis-2026-09-13T10-29-25-354Z/diagnosis.json` |
| 定向诊断日志 | `tmp/firefox-swarm-acceptance/snapshot-ref-diagnosis-0.0.138-2026-09-13T10-29-25Z.log` |

## 完整结果（每项 PASS/FAIL/SKIP）

- [PASS] preflight :: connected Firefox profile present
- [PASS] preflight :: extension version is 0.0.138
- [PASS] preflight :: capabilities report webextension/dom/isolated
- [PASS] preflight :: profiles endpoint has no extra connected Firefox profile
- [PASS] session-isolation :: fresh session lists no foreign groups
- [PASS] session-isolation :: fresh session lists no tabs
- [PASS] create :: groups.create returns a groupId
- [PASS] create :: tabs.create returns a tabId
- [PASS] create :: created tab binds to the group/profile
- [PASS] create :: created tab navigates to the fixture URL
- [PASS] snapshot-ref :: page.snapshot returns snapshotId + refs
- [PASS] snapshot-ref :: snapshot refs are unique and carry role/name
- [PASS] snapshot-ref :: snapshot text is non-empty and shaped as lines
- [PASS] snapshot-ref :: page.fill by snapshot ref succeeds
- [PASS] snapshot-ref :: DOM value reflects the ref-based fill
- [PASS] snapshot-ref :: reusing a ref after DOM change is refused as stale
- [PASS] snapshot-ref :: strict selector with two matches is refused (no .first fallback)
- [PASS] snapshot-ref :: click on a hidden element is refused
- [PASS] role-forms :: getByRole textbox fill updates inputValue
- [PASS] role-forms :: getByLabel reads the existing note
- [PASS] role-forms :: textarea fill updates value
- [PASS] role-forms :: checkbox check() reports checked
- [PASS] role-forms :: select selectOption("beta") updates value
- [PASS] role-forms :: contenteditable fill updates text
- [PASS] role-forms :: getByTestId resolves data-testid
- [PASS] role-forms :: submit click produced the page DOM result
- [PASS] role-forms :: saved form state reflects DOM actions
- [PASS] role-forms :: DOM click is not a trusted native event (documented boundary)
- [PASS] hidden-filtering :: snapshot includes a visible control
- [PASS] hidden-filtering :: snapshot excludes hidden/aria-hidden/inert controls
- [PASS] hidden-filtering :: role locator filters aria-hidden/inert/hidden elements
- [PASS] shadow-dom :: open shadow DOM input is fillable/readable via role+label
- [PASS] shadow-dom :: open shadow DOM button is clickable and mutates the DOM
- [SKIP] shadow-dom :: compound CSS selector crosses the shadow boundary
- [PASS] shadow-dom :: chained locator traverses the host element shadowRoot
- [PASS] iframe-same-origin :: same-origin iframe locator reads content
- [PASS] iframe-same-origin :: same-origin iframe locator fills content
- [PASS] iframe-cross-origin :: cross-origin iframe read works
- [PASS] iframe-cross-origin :: cross-origin iframe fill works
- [PASS] iframe-geometry :: click in a bordered/padded no-transform frame hits the target
- [PASS] iframe-geometry :: transformed frame action is explicitly refused (no approximation)
- [PASS] iframe-geometry :: fractional-geometry frame action is explicitly refused (no approximation)
- [PASS] iframe-geometry :: occluded frame action is refused or does not activate the target
- [PASS] navigate-back :: page.navigate succeeds
- [PASS] navigate-back :: page.navigate really reaches the target URL
- [PASS] navigate-back :: page.back succeeds
- [PASS] navigate-back :: page.back really returns to the prior URL
- [PASS] navigate-back :: page.back response URL matches the completed navigation
- [PASS] navigation-chain :: page.navigate follows a meta-refresh redirect and returns the final URL
- [PASS] navigation-chain :: final document really loaded for the meta-refresh redirect
- [PASS] navigation-chain :: page.navigate follows a location-replace redirect and returns the final URL
- [PASS] navigation-chain :: final document really loaded for the location-replace redirect
- [PASS] navigation-chain :: page.navigate settles after history.replaceState on load
- [PASS] navigation-chain :: replaceState URL matches the final document
- [PASS] navigation-chain :: page.navigate settles after a load-time hash change
- [PASS] navigation-chain :: hash-change URL matches the final document
- [PASS] navigation-chain :: same-document fragment navigation returns the fragment URL
- [PASS] navigation-chain :: fragment URL matches the final document
- [PASS] navigation-chain :: page.back after a same-document fragment returns the base URL
- [PASS] navigation-chain :: page.back response matches the completed fragment navigation
- [PASS] target-blank :: clicking a target=_blank link succeeds
- [SKIP] target-blank :: opened tab is associated with sourceTabId
- [PASS] screenshot :: plain screenshot returns an artifact
- [PASS] screenshot :: plain screenshot file is a non-empty PNG
- [PASS] screenshot :: labels screenshot returns an artifact
- [PASS] screenshot :: labels screenshot file is a non-empty PNG
- [PASS] network :: network capture starts
- [PASS] network :: page fetch was triggered
- [PASS] network :: network list retains the fixture request
- [PASS] network :: retained row has status and (bounded) response body
- [PASS] network :: network capture stops
- [PASS] network :: network rows are retained after stop
- [PASS] network-filter :: capture starts for the filter suite
- [PASS] network-filter :: six concurrent fetches complete
- [PASS] network-filter :: all concurrent requests are captured
- [PASS] network-filter :: page realm receives the complete UTF-8 payload
- [PASS] network-filter :: recorded UTF-8 JSON bodies are complete (or explicitly truncated) and decode exactly
- [PASS] network-filter :: page realm receives the complete original large response
- [PASS] network-filter :: capture record for the large body is bounded or explicitly truncated
- [PASS] network-filter :: capture stops before restart
- [PASS] network-filter :: stop retains the earlier captured rows instead of erasing them
- [PASS] network-filter :: capture restarts after stop
- [PASS] network-filter :: post-restart fetch completes
- [PASS] network-filter :: requests after restart are captured
- [PASS] network-filter :: restart is reported as a documented replacement, not a silent loss
- [PASS] network-filter :: a new explicit start while capture is active replaces the previous capture
- [PASS] network-filter :: the replaced capture starts empty (previous rows are not carried over)
- [PASS] network-filter :: a matching request after the active start is captured (page realm received the full UTF-8 payload)
- [PASS] network-filter :: the page realm receives the complete original large response after the active start
- [PASS] network-filter :: non-matching request completed in the page (filter control)
- [PASS] network-filter :: only filter-matching requests are recorded into the new capture
- [PASS] logs :: console.log call still lets the page run (DOM event-log appended)
- [PASS] logs :: page.logs captures the fixture console line
- [PASS] logs :: captured page error must be absent for a plain console.log
- [PASS] execute-reads :: execute reads title/url/heading/count/getAttribute
- [PASS] execute-reads :: execute strict role count sees both duplicate buttons
- [PASS] execute-reads :: execute locator isVisible returns a boolean
- [PASS] unsupported :: page.evaluate is refused without userScripts (unsupported-capability)
- [PASS] unsupported :: evaluate refusal names the userScripts permission
- [PASS] unsupported :: execute page.mouse is refused explicitly
- [PASS] unsupported :: execute page.keyboard.down is refused explicitly
- [PASS] unsupported :: evaluate inside execute is refused without userScripts
- [PASS] locator-strictness :: locator count of a missing selector returns 0
- [PASS] locator-strictness :: ambiguous role locator action is refused (no .first fallback)
- [PASS] locator-strictness :: execute action on a missing selector returns a typed timeout
- [PASS] locator-strictness :: protocol page.click on a missing selector returns a typed timeout
- [PASS] cancellation :: fixture counter readable (Number.isFinite)
- [PASS] cancellation :: request.cancel returns ok:true
- [PASS] cancellation :: cancelled page.execute returns ok:false with code cancelled
- [PASS] cancellation :: cancelled action does not fire after its original wait
- [PASS] cancellation :: positive control: same action fires without cancel
- [PASS] cancellation :: positive control increments the counter exactly once
- [PASS] insecure-context :: created a controlled tab on a non-localhost HTTP origin
- [PASS] insecure-context :: page realm reports an insecure context without crypto.randomUUID
- [PASS] insecure-context :: snapshot works on a non-secure HTTP origin
- [PASS] insecure-context :: content-script locator read works on a non-secure HTTP origin
- [PASS] release-isolation :: created a dedicated tab for the release test
- [PASS] release-isolation :: tabs.release succeeds and marks the tab released
- [PASS] release-isolation :: control of a released tab is refused
- [PASS] release-isolation :: a second session cannot list the first session groups
- [PASS] release-isolation :: a second session cannot list tabs of the first group
- [PASS] release-isolation :: a second session cannot operate the first session tab
- [PASS] release-isolation :: a second session cannot close the first session tab
- [PASS] release-isolation :: released tab can be re-adopted for cleanup
- [PASS] release-isolation :: re-adopted released tab is closed
- [PASS] idle :: connection stays stable across 96s of read-only sampling
- [PASS] cleanup :: no live owned tabs remain after cleanup
- [PASS] cleanup :: no fixture-created physical tabs remain in the browser

## Findings（2，均为既定边界，非失败）

1. `shadow-dom :: compound cross-shadow CSS is an explicit non-goal for this round` —— 本轮不交付，不称已修。
2. `target-blank :: DOM click does not open a target=_blank tab` —— DOM 点击不可信 + Firefox 弹窗拦截，`sourceTabId` 未被行使。

## 范围与限制

- 只验证本 harness 的本地无敏感数据 fixture；未测试任何用户真实业务站点，未接管/导航/关闭用户既有页面。
- 未运行 runtime unit/integration（由协调者串行）；未触碰 `19989`；未重载扩展、未改 Firefox 设置/权限。
- 日志/证据只写本 worktree `tmp/`；未输出 token/ticket/cookie/私钥。
- 本报告不代表全部 Gecko 浏览器、全部站点或与 Chrome 全面对等；仅代表本次 0.0.138 实测。
