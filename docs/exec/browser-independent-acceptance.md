---
title: Browser Runtime v1 独立验收报告（候选 23c3ebd）
description: 全新独立验收 agent 对 review/browser-rebuild@23c3ebd 的无浏览器验收结论、P0/P1 精确证据、已验证契约、平台限制与 Chrome 未验收声明。
prompt: |
  全新独立最终验收 agent（此前无实现上下文），只验收不修产品、不 commit/push，
  不启动 Chrome/Chromium/headless/browser 工具，不碰日常 19988 与用户 profile。
  阅读 @AGENTS.md @README.md @playwriter/src/skill.md
  @docs/exec/browser-rebuild-plan.md @docs/exec/browser-runtime-contract.md
  @playwriter/src/browser-protocol.ts @PLAYWRITER_AGENTS.md @MEMORY.md
  独立核查 @pi/extensions/index.ts @pi/extensions/bootstrap.ts
  @pi/extensions/runtime-client.ts @pi/skills/SKILL.md
  @extension/src/managed-groups.ts @extension/src/resource-registry.ts
  @extension/src/resource-storage.ts @extension/src/persist-queue.ts
  @extension/src/request-tracker.ts @extension/src/keyed-queue.ts
  @extension/src/internal-moves.ts @extension/src/background.ts
  @extension/manifest.json @extension/vite.config.mts
  @extension/scripts/build-extension.mjs
  @playwriter/src/managed-relay.ts @playwriter/src/managed-executor-pool.ts
  @playwriter/src/managed-executor-facade.ts @playwriter/src/managed-executor-worker.ts
  @playwriter/src/managed-executor-protocol.ts @playwriter/src/cdp-relay.ts
  @playwriter/src/runtime-cli.ts @playwriter/src/utils.ts @playwriter/src/create-logger.ts
  @playwriter/src/resource-storage.ts @playwriter/vitest.unit.config.ts
  @playwriter/vitest.integration.config.ts @.github/workflows/ci.yml
  @playwright/packages/playwright-core/src/server/chromium/chromium.ts
  @playwright/packages/playwright-core/src/server/chromium/crBrowser.ts
  @playwright/packages/playwright-core/src/server/chromium/crPage.ts
  用 pnpm install --frozen-lockfile 安装依赖，跑 runtime typecheck/build/smoke/
  test:unit/test:integration、pi typecheck/test/load-check、extension tsc/test，
  以及 tmp 下的真实打包 HTTP/WS 与 worker runtime 的桩级探针；禁止 tests -u、
  禁止 locator-selector/任意 Chrome 测试。交付 PASS/FAIL/INCOMPLETE 与 P0/P1。
---

# 结论

- 候选 23c3ebd：**FAIL**（独立验收不通过，不可进入合并门槛）。
- 阻塞项：1 个 P0（worker 错误 outcome 语义错误，已用真实 worker runtime 探针复现）。
- Chrome 阶段：**INCOMPLETE（未执行）**。本报告所有“通过”均不含真实浏览器验证；
  worker fixture / 桩 page / HTTP stub 不等同真实 Chrome 全链路。
- 已知在修（协调者确认，不作为本候选最终缺陷重复计）：
  B 的 managed-executor-pool 动态 import 临时接线与 Linux 队列测试 flaky；
  C 的 worker outcome/lease 修复；D 的 body 取消边界修复。
  其中 C 的 outcome 问题本次已独立复现并记录为 P0，供修复后复审。
- 后验补充（2026-09-10，只读核验，不改本工作树）：B 的 `107d274` 已在
  integration 落地——managed-relay 顶部静态 `import { ManagedExecutorPool }`，
  删除 lazy loader/duck-type guard/poolUnavailable 回退，capabilities
  直接报 `isolatedExecution: true`。该项由此不再属于“待接通”缺口；本报告
  对其余结论不变（该文件属 B 分支，未进入本次 23c3ebd 证据快照）。

# 环境与安装方式

- 工作树：`tmp/swarm-rebuild/review`，HEAD `23c3ebd`（分支 review/browser-rebuild）。
- 平台：macOS arm64（Darwin 25.6.0），Node v26.8.2，pnpm 10.18.1，bun 1.4.2。
- 依赖：`pnpm install --frozen-lockfile --registry https://registry.npmjs.org`
  （1,581 包全部来自本机 pnpm store，0 下载，16.8s；esbuild/sharp 等 build script
  被 pnpm 忽略，未影响本次构建与测试）。
- 子模块：`git submodule update --init --reference <主仓库>/playwright`，落在
  期望的 `2074cbb1d`（playwriter 分支，未改代码）。用 `--reference` 复用本地
  对象而非全量网络克隆，故**不是洁净克隆**（依赖与子模块均非空网获取）。
- 全程未启动 Chrome/Chromium/headless；未触碰 19988 与用户 profile。
  验证时观察到 19988 由用户既有 `playwriter-ws-server`（PID 68650）占用，
  19989 被一个 Chrome Helper 进程占用（均非本次验收启动）。

# 已执行检查与结果（可复跑）

命令均在 review 工作树执行；完整输出：`tmp/review-23c3ebd/suites-rerun.log`。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| runtime typecheck | `pnpm --filter @tom-cat/pi-browser-runtime typecheck` | 通过（无输出） |
| runtime 构建 | `pnpm --filter @tom-cat/pi-browser-runtime build` | 通过（9s，含 dist/dist-packaged） |
| 发行 smoke | `pnpm --filter @tom-cat/pi-browser-runtime smoke` | 通过：fork 扩展 ID eeklahpecooapnailfaebkjjembkjhhg + 19989 |
| runtime unit | `pnpm --filter @tom-cat/pi-browser-runtime test:unit` | 17 文件 / 217 用例通过（复跑一致） |
| runtime integration | `pnpm --filter @tom-cat/pi-browser-runtime test:integration` | 4 文件 / 34 用例通过（含真实子进程、真实端口 kill） |
| extension 测试 | `pnpm --filter mcp-extension test` | 5 文件 / 34 用例通过 |
| extension tsc | `pnpm --filter mcp-extension exec tsc --project .` | 通过 |
| pi typecheck | `pnpm --filter @tom-cat/pi-browser-use-extension typecheck` | 通过 |
| pi 测试 | `pnpm --filter @tom-cat/pi-browser-use-extension test` | 3 文件 / 48 用例通过（真实 HTTP 测试服务器） |
| pi load-check | `pnpm --filter @tom-cat/pi-browser-use-extension load-check` | 12 工具 + browser-status + session_shutdown 注册成功 |

未运行（按用户限定）：`locator-selector`、默认 `pnpm test`（带 `-u` 会改快照）、
任何 Chrome 依赖套件；未审 acceptance 54c1f07 的 ~3k 行 harness。

## 打包产物真实 HTTP/WS 端到端（无 Chrome）

探针：`tmp/review-23c3ebd/runtime-http-e2e.mts`、`runtime-ws-close.mts`
（输出 `*.out.json`）。启动真实 `playwriter/dist/runtime-cli.js`，独立端口/数据目录。

- `GET /browser/v1/capabilities`：200，`protocolVersion=1`、managedGroups/
  persistentOwnership/explicitTabs/isolatedExecution 均 true。
- 错误 token → 401；`sec-fetch-site: cross-site` → 403。
- 非 JSON / 错误 Content-Type / 未知 kind / 多余字段 → 400（消息明确）。
- `profiles.list` → 200 ok；`groups.list`（无扩展连接）→ `profile-disconnected`。
- `session.release` → ok，文本明确“groups and tabs are preserved”。
- 未登记 tab 的 `page.navigate` → `resource-not-found`（未起 worker）。
- 未知 target 的 `request.cancel` → `resource-not-found`。
- managed CDP WS 无 profile/未知 profile → 关闭 4002 + 明确 reason；
  legacy `/cdp` 无扩展 → 关闭 4003（消息为 "Multiple extensions connected…"，
  0 个扩展时措辞不准确，见 P3-2）。
- 日志落盘在 `PI_BROWSER_DATA_DIR`（relay-server.log + cdp.jsonl），未污染
  `~/.playwriter`，行为与 README/契约一致。

## Playwright connect 初始化 vs managed CDP 白名单（静态核验，无 Chrome）

- `Browser.getVersion`、`Browser.setDownloadBehavior` 在 relay 中既被 Browser.*
  例外豁免又在 root 允许列表内（managed-relay.ts:2535-2552、3046-3059），
  初始化不会因白名单被拒。
- `Browser.getWindowForTarget`：connectOverCDP 固定 `noDefaultViewport: true`
  （playwright/.../chromium.ts:111），crPage.ts:433-438 的该分支因此不执行，
  不会触发 Browser.* 拒绝；白名单未放行它（若未来改用非 noDefaultViewport
  连接会立刻断裂，属隐性耦合，见 P3-1）。
- `Target.setAutoAttach` / `Target.setDiscoverTargets` / `Target.getTargetInfo`
  均在 root 允许列表；会话级命令（Page.enable、Runtime.enable、
  Page.setLifecycleEventsEnabled、Emulation.*、Network.*、会话级 setAutoAttach）
  由默认分支携带 `sessionId` 转发（cdp-relay.ts:1077-1081 附近）。
- 结论：connect 初始化所用命令集合在白名单内**静态可通**；真实链接未跑。

## worker runtime 桩级探针（真实 worker 代码，桩 page/context）

探针：`tmp/review-23c3ebd/worker-outcome-probe.mts`（输出 `*.out.json`）。

- `browser_execute` 代码 `await page.click('#buy-now'); throw new Error(...)`：
  返回 `execution-failed / outcome=not-started`，但探针记录到 click 已执行
  （`clicksRecorded: 1`）。→ P0-1。
- `page.navigate` 在 goto 中断时报 `execution-failed / not-started`；
  `page.click` 原始 Playwright 异常同样 `not-started`。→ P0-1 同类。
- 成功返回的 `page.execute` 里 `setTimeout(...page.click...)`：请求 A 返回后
  定时器在请求 B 执行期间发出 click（clicksAfterA=0 → clicksAfterB=1），
  无隔离、无法用 request.cancel 取消。→ P1-1。

## facade 包装缺口探针（桩级）

探针：`tmp/review-23c3ebd/facade-escape-min.mts`（输出 `*.out.json`）。

- `page.close()` 被 facade 拒绝（符合设计）。
- 但 `page.frames()[0].page()` 返回**原始 page**：`rawPage.close()` 实际执行；
  经该链条 `rawContext.newPage()` 与 `rawBrowser.close()` 也实际执行。
- `locator.elementHandle()` 返回原始 ElementHandle；`page.mainFrame().page()`、
  `locator.page()` 则被正确包装。
- 缓解：relay 侧 `MANAGED_DENIED_METHODS` 拒绝 Browser.close / Target.createTarget /
  Target.disposeBrowserContext 等（managed-relay.ts:3062-3084），且逐命令校验
  session/target 归属（:2531-2554），故该缺口不能关浏览器、建未归属标签或驱动
  其他 session 的标签。→ P2-1（契约/纵深防御，非跨 owner 突破）。

# P0 / P1 清单（含真实触发序列）

## P0-1 worker 错误一律 `not-started`，已完成副作用仍报未开始

- 位置：
  - `playwriter/src/managed-executor-worker.ts:107-127`（默认 outcome=not-started）
  - `playwriter/src/managed-executor-worker.ts:814-820`（page.execute catch 未传 outcome）
  - `playwriter/src/managed-executor-worker.ts:919-940`（generic errorResponse 硬编码
    not-started；page.navigate/click/fill 的原始 Playwright 异常走这里）
- 触发序列（真实路径，探针已复现）：
  1. Pi 调 `browser_execute`（page.execute）执行 `await page.click('#buy-now'); throw ...`；
  2. worker 内 vm 先发出真实 CDP click（副作用已发生），随后抛错；
  3. worker `errorResponse` 返回 `code=execution-failed, outcome=not-started`；
  4. pool（managed-executor-pool.ts:399-408）原样透传 worker 响应；
  5. relay（managed-relay.ts:1830-1845）解析后原样返回，Pi 层暴露 `outcome=not-started`。
- 影响：`pi/skills/SKILL.md:76-79` 明确告诉模型 `unknown` 才代表“可能已部分发生”，
  `not-started` 会被理解为“没发生”，诱发重复点击/重复提交；违反契约
  browser-runtime-contract.md:53 与 :119-120（已发出的动作必须如实报告 unknown）。
- 同类：`browser_navigate` 的 goto 超时/中断（导航可能已提交）、
  `browser_click`/`browser_fill` 在动作已派发后超时。
- 修复方向：worker 增加 per-execution “副作用已开始”标记（首个变更类动作后置位），
  `errorResponse`/executeJavaScript catch 据此返回 `unknown`；pool 已有 `started`
  标记但只覆盖自身 kill 路径，worker 自报错误未被覆盖。
- 状态：协调者已安排 C 修复；本候选未修复，**复审必须先看此项**。

## P1-1 成功返回的 page.execute 残留定时器/监听跨请求发指令

- 位置：
  - `playwriter/src/managed-executor-worker.ts:744-800`（每次 execute 建 vm context，
    但 `state`/`userState` 跨请求保留，`state.page` 指向 facade）
  - `playwriter/src/managed-executor-worker.ts:1135-1169`（命令串行执行，请求间无清理）
  - kill 语义只覆盖 cancel/timeout/release（managed-executor-pool.ts:136-176、531-575）
- 触发序列（探针已复现）：
  1. 请求 A（page.execute）成功返回，期间 `setTimeout(() => page.click(...))`；
  2. 请求 B 在同一 session/profile worker 上执行；
  3. A 的定时器在 B 期间发出 click（探针：clicksAfterA=0 → clicksAfterB=1）。
- 影响：绕过 relay 的 per-profile 输入互斥（managed-relay.ts:1353-1377），
  且 request.cancel 只能杀 worker、无法只取消某请求的残留；契约 :122
  “取消/释放后不得再发 CDP 指令”未覆盖“成功请求的残留”。当前工具描述与
  pi/skills 未对 background 残留给出边界或做法。
- 建议：要么在 page.execute 描述/技能中明确“不得留后台回调，唯一清理是
  session.release/取消杀进程”，要么实现请求级 teardown（记录本请求创建的
  timer/interval 与 facade 监听，返回前清理；需要后台时显式 opt-in）。

## P1-2（降级为 P2）取消/超时后新旧 worker 短暂并存

- 位置：`playwriter/src/managed-executor-pool.ts:570-575`（`void invalidateWorker`）、
  `:588-595`（先从 map 删除再 kill）、`:267-309`（随后直接 spawn 新 worker）。
- 触发序列：请求 A 超时/取消 → 响应先返回（unknown）→ 250ms 内请求 B 到达同
  session/profile → B 用新 connectionEpoch 起新 worker，而旧进程可能仍在退出。
- 缓解：relay 已在 cancel 后 `invalidateSlot` 并关闭旧 managed CDP 连接
  （managed-relay.ts:2183-2201、2365-2376），暴露窗口限于“已发出的 CDP 命令”，
  故记 P2；修复方向是记录 invalidation promise 并在同 key 复用前 await。
  现有 pool 测试（managed-executor-pool.test.ts:79-107）本身期望“立即换新 worker”。

## P2-1 facade 原始对象泄漏（见上）与 P3

- P2-1：`page.frames()`/`elementHandle()` 返回未包装对象；`wrapGeneralResult`
  （managed-executor-facade.ts:460-478）不包装 Frame/ElementHandle。
  缓解成立（relay 白名单），但违反契约 :122 的“不提供未管控通道”精神。
- P3-1：managed 客户端建立时仍走 legacy `maybeAutoCreateInitialTab`
  （cdp-relay.ts:900-915、700-737）；扩展在 publish inventory 前先重挂
  （managed-groups.ts:362-391），故实践中难以触发，但缺少显式 managed 守卫。
- P3-2：0 个扩展连接时 legacy `/cdp` 关闭原因文案为 “Multiple extensions
  connected…”，有误导性（cdp-relay.ts:1469-1477）。
- P3-3：本机 19989 被 Chrome Helper 占用（非本分支问题）；Chrome 阶段若沿用
  默认端口，`pi-browser-runtime` 会拒绝替换并以“listener without the managed
  browser API”退出，需要先释放或改用 `PI_BROWSER_PORT`。
- P3-4：needs-rebind 资源没有任何“重新绑定”工具路径，只能 groups.close 后新建；
  属安全降级但缺 UX 出口（managed-groups.ts:845-850、932-937 文案已说明）。

# 已独立核验通过的契约点（无浏览器范围内）

1. 身份/所有权：relay 按 sessionId 过滤 groups/tabs（managed-relay.ts:1287-1325）；
   resolve 系列校验 session 归属（:2887-2971）；cancel 不能跨 session（:2056-2091）；
   扩展 `requireGroup/requireTab` 同样校验（managed-groups.ts:759-788）。新 fork 的
   Pi UUID（新 session）无法看到/取消旧 session 资源与进行中请求。
2. session 注入：Pi 每次请求从 `ctx.sessionManager.getSessionId()` 现取
   （pi/extensions/bootstrap.ts:56-62；index.ts:141），无 LLM 参数、无模块级缓存；
   Pi 只是工具层，无 HITL/业务重放/验证码逻辑（全文件核查）。
3. ID 入 LLM content：`buildStructuredText` 把 group/tab/snapshotId/value 序列化进
   content（pi/extensions/index.ts:180-247），details 仅 UI。
4. release/拖出/取消：用户拖出 → tombstone（managed-groups.ts:1607-1639）；
   reconcile 尊重 tombstone 与 revision 围栏，不反向覆盖（resource-registry.ts:657-746）；
   Chrome 重启 → needs-rebind（:748-774）；`session.release` 只释放 worker
   （managed-relay.ts:2037-2054）；Pi shutdown 只调 session.release
   （pi/extensions/index.ts:725-728）；用户 Chrome 内取消 → 全量 release 且保留组
   （managed-groups.ts:1657-1701）。
5. snapshot refs：按 page generation 存储并校验，ref 必须带 snapshotId 且
   不 first()/nth() 兜底（managed-executor-worker.ts:872-917、540-569）。
6. 新旧 WS 兼容：`browserInventory`/`browserRequest` 为新增命名空间，旧 method
   原样保留；fork 扩展 ID/端口固定（extension/vite.config.mts、build-extension.mjs），
   smoke 断言 eeklahpecooapnailfaebkjjembkjhhg + 19989；不抢上游身份。
7. 日志/启动：文件日志 append + 轮转 + 有界缓冲，失败不毒化队列
   （create-logger.ts:41-189）；端口被占只探测不替换（runtime-cli.ts:60-90）；
   Pi bootstrap 只启动配套 runtime、远端不 spawn、/browser-status 只读
   （pi/extensions/bootstrap.ts:78-130、index.ts:695-721）。

# 未验证清单（Chrome 阶段必须补）

真实扩展加载与 debugger attach；真组/真标签/命名与颜色；tabs.create 真导航与
入组；target=_blank、window.open、OAuth popup 归组；用户拖出/取消控制的真实事件
时序；SW 重启与扩展重载恢复；浏览器整体重启 needs-rebind；真实 page.snapshot/
click/fill/navigate/screenshot/network/logs 与 managed CDP 白名单在真实数据上的
表现；worker 真实 connectOverCDP 初始化；取消/超时对真实动作的 unknown 语义；
P0-1 在真实 Chrome 下的 goto/click 变体。上述任一项未过，不得宣称浏览器已验收。

# 限制与说明

- 本报告未审 `feat/browser-acceptance-harness`（54c1f07，约 3k 行），按指示跳过。
- B 的动态 import 临时接线已由 `107d274` 静态化并在 integration 删除
  （只读 `git show` 核验），不再作为缺口；本报告缺陷清单不含该项。
- worker fixture、桩 page、HTTP 探针都不等于真实 Chrome；本报告的所有 PASS
  仅限所列范围。
- 证据文件（ignored，持久保留）：`tmp/review-23c3ebd/` 下的
  `suites-rerun.log`、`worker-outcome-probe.*`、`facade-escape-min.*`、
  `runtime-http-e2e.*`、`runtime-ws-close.*`、以及 runtime-e2e-*/runtime-ws-*
  数据目录。
