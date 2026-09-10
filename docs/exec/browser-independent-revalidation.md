---
title: Browser Runtime v1 增量复验报告（候选 d607439）
description: 对冻结候选 d607439 仅重跑 worker-outcome 与 facade/lease 两个适配探针的增量复验；明确原 P0/P1/P2 三项的修复状态、未覆盖的 known pending 与 Chrome 仍未验收。
candidate: d607439
inputs:
  - 原 FAIL 报告：docs/exec/browser-independent-acceptance.md（23c3ebd；备份 tmp/review-23c3ebd/original-independent-acceptance.md，SHA256 9ba7896c…）
  - C f10b201 fix: harden managed executor invalidation（outcome/lease/timer scope/facade 包装）
  - B 107d274 静态链接 executor pool（只读核验，见原报告后验补充）
  - D 6595df2 fix(pi): byte-accurate output budgets, item-wise list truncation, listener cleanup
  - E eab8301 docs/README 80 列包装；acceptance 5f4c19f（原报告入库）
  - 探针：tmp/review-d607439/worker-outcome-probe-v2.mts、facade-escape-min-v2.mts
prompt: |
  用户要求：以 d607439 为冻结候选做一次独立增量复验（不是最终绿灯），只重跑
  worker-outcome-probe 与 facade-escape-min 两个探针，如需适配可复制到
  tmp/review-d607439/ 修改，旧证据不覆盖。用真实 ManagedExecutorWorkerRuntime
  + 桩 page 记录：副作用后 unknown；无效 URL/ref 之前 not-started；timer A 结束
  后 B 期间无 click；frames/elementHandle 链不返回 raw；facadeA 释放后同 raw page
  的 facadeB 不能复活 A，旧 state.page/locator 句柄普通复用边界明确。
  不跑数千行 harness/全套件（协调者跑），只读产品、不 commit/push、不启动
  Chrome/Chromium/headless/浏览器工具、不动 19988 与用户 profile。
  结论需明确原三项修复/剩余什么，Chrome 依旧 INCOMPLETE；known pending 不可给
  最终 PASS。输出 docs/exec/browser-independent-revalidation.md。
---

# 结论（增量复验，非最终绿灯）

- **原 P0（worker 副作用后报 not-started）：FIXED**（代码 + 运行时探针双重确认）。
- **原 P1（page.execute 残留 timer/监听跨请求发指令、旧句柄可复用）：FIXED**
  （请求级 lease + timer scope + 每请求新 facade；探针确认 A 的 timer 在 B 期间
  0 次 click，A 的 page/locator 句柄在 B 内即抛 lease-expired）。
- **原 P2（facade 泄漏 raw 对象，frames()/elementHandle() 链可达 raw close/
  newPage/browser.close）：FIXED**（包装补全 + 逐调用 lease 校验 + dispose 移除
  监听；探针确认三处破坏路径全部被拒且 raw 计数为 0）。
- **仍不可给最终 PASS**：以下 known pending 本轮按要求未复测——
  C：`context.getExistingCDPSession` 直接泄漏 raw；CDP `on` 订阅未随 request 清理；
  timer async reject（异步 handler 的 rejection 未处理）；
  pool active 提前 settle（假 terminated）。
  D：single 巨标题/URL、多个 lists 预算、emoji 边界。
  另有原报告 P2（取消/超时后新旧 worker 短暂并存）本轮未起探针，随 C 的 pool
  修复一并复审。
- **Chrome 阶段：INCOMPLETE（未执行）**。本轮仍为零 Chrome：桩 page/stub 对象
  不等于真实浏览器；全部结论仅限无浏览器范围。

# 候选与证据保全

- review 工作树 HEAD：`d607439`（merge B 107d274 + C f10b201 + D 6595df2 +
  E eab8301 + acceptance 5f4c19f），`git status` 干净。
- 原 23c3ebd 证据目录 `tmp/review-23c3ebd/` 完整保留；原 FAIL 报告
  `docs/exec/browser-independent-acceptance.md` 已随候选入库（未改动），
  并行备份 `tmp/review-23c3ebd/original-independent-acceptance.md`
  （sha256 `9ba7896c…`）可用。
- 本轮只新增：`tmp/review-d607439/` 两个探针及其输出，和本报告；
  未修改任何产品文件、未 commit/push。

# 复验方法

命令（均在 review 工作树、默认配置、无 Chrome）：

```
pnpm exec tsx tmp/review-d607439/worker-outcome-probe-v2.mts
pnpm exec tsx tmp/review-d607439/facade-escape-min-v2.mts
```

输出：`tmp/review-d607439/worker-outcome-probe-v2.out.json`、
`facade-escape-min-v2.out.json`（stderr 仅 tsx Deprecation 提示）。
两探针都使用**真实** `ManagedExecutorWorkerRuntime` /
`ManagedPlaywrightFacade` / `ManagedExecutionLease` 代码，仅把
Page/BrowserContext/Browser 换成记录调用的桩对象——不是 Chrome 集成测试。

# 逐项核验结果

## 1. 副作用后 unknown／无效 URL、ref 之前 not-started（P0）

| 探针 | 观察 | 结果 |
| --- | --- | --- |
| `page.execute`：click 后 throw | `execution-failed/unknown`，clicks=1 | ✅ unknown |
| `page.navigate`：javascript: scheme | `invalid-request/not-started`，goto=0 | ✅ 未开始 |
| `page.click`：aria-ref 无 snapshotId | `stale-snapshot/not-started`，clicks=0 | ✅ 未开始 |
| `page.click`：未知 snapshotId | `stale-snapshot/not-started`，clicks=0 | ✅ 未开始 |
| `page.click`：原始 Playwright 异常（已派发） | `execution-failed/unknown`，attempts=1 | ✅ unknown |

实现核对：`sideEffectsStarted` 在 `execute()` 内跟踪（worker.ts:160-183），
`errorResponse` 统一走 `resolveManagedOperationOutcome`（:1013-1052）；
mark 点位于 validate URL 之后（navigate :518）、resolveActionLocator 之后
（click :546 / fill :571）、evaluate :621、execute 入口 :892、screenshot
:665/:671、snapshot 入口（只读也保守标记）。无效 URL/ref 在 mark 之前抛出，
故 not-started 语义保留。

## 2. 残留 timer/监听与旧句柄边界（P1）

- 请求 A：`setTimeout(() => page.click('#late-timer-click'), 30)` 成功返回；
  请求 B 运行 90ms。结果 `clicksAfterA=0, clicksAfterB=0` —— A 的 timer 被
  请求级 `ManagedTimerScope.dispose()` 清除，且回调在 lease 失效后也会被丢弃。
- A 存入 `state.oldPage`/`state.oldLocator` 的句柄在 B 中被复用：
  两者都抛 `Managed raw execution lease has expired; future browser control
  calls are rejected`，B 的响应 ok 且无 raw 动作 —— 普通复用边界明确为
  fail-closed（跨请求只应传递纯数据，不应复用 Playwright 句柄）。
- 实现核对：每次 `page.execute` 新建 `ManagedExecutionLease` + `ManagedTimerScope`
  + 新 facade（worker.ts:786-793），`finally` 中 `lease.release() /
  timerScope.dispose() / facade.dispose()`（:907-912）；`ManagedTimerScope`
  包装 vm 内 setTimeout/setInterval/clear（worker.ts:860-885，lease.ts:22-75）。

## 3. facade 包装与释放语义（P2）

- 包装补全：`frames()` 入 PAGE_FRAME_METHODS（facade.ts:26）、
  locator `elementHandle/elementHandles` 包装（:46）、element `ownerFrame`
  包装（:57）；探针 identities 全部 `*IsRaw=false`，
  `page.keyboard === undefined`。
- 旧 raw 链在 lease 有效期内也全部被拒：
  `frames()[0].page().close()`、`.context().newPage()`、
  `.context().browser().close()` 均抛 forbidden，计数
  pageClose=0 / contextNewPage=0 / browserClose=0。
- 释放后：facadeA `lease.release()`+`dispose()` 后，A 的 page/locator/element/
  frame-page 句柄以及 `facadeA.wrapPage(raw)` 的再次使用全部抛 lease-expired
  （`wrapAgainIdentity=true` 但使用失败）；随后同一 raw page 上建 facadeB →
  身份不同、可正常 click，facadeA 仍保持失效 —— **A 不被 B 复活**。
- 监听清理：A 注册 `page.on('console')` 后 dispose，桩记录
  `eventsOn=1 → eventsOffAfterDispose=1`（facade.ts:476-500）。

# 未覆盖与仍待复审

1. C known pending（本轮未复测，不得视为通过）：
   `context.getExistingCDPSession` raw 泄漏、CDP `on` 订阅不随 request 清理、
   timer 异步 rejection 未处理、pool active 提前 settle 假 terminated。
2. D known pending（本轮未复测）：single 巨标题/URL、多 lists 预算、emoji 边界。
3. 原报告 P2：取消/超时后新旧 worker 短暂并存（`managed-executor-pool.ts`
  取消路径仍为 fire-and-forget invalidate）；与该文件的 pending 修复一起复审。
4. 本轮按指示未跑 unit/integration/pi/extension 套件与 acceptance harness
   （协调者负责）；未跑任何 Chrome 测试。
5. 平台限制不变：macOS arm64、Node v26、桩 page/stub 对象；19988/19989 与用户
   profile 未触碰（19989 仍被本机 Chrome Helper 占用，Chrome 阶段需先释放或
   换 `PI_BROWSER_PORT`）。

# 下一步

- 等 C/D 最终提交后，按实际 diff 复审上述 pending（尤其 pool 取消/替换路径与
  CDP session/订阅清理），必要时把对应探针复制到新的 `tmp/review-<候选>/` 再跑。
- 之后才谈冻结最终报告；Chrome 阶段在用户配合下另行验收，完成前不得宣称
  浏览器通过或合并 main。
