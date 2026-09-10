---
title: Browser Runtime v1 无浏览器验收（冻结候选 a4e1669）
description: 收尾复审 C/D 全部 pending 后的无浏览器 PASS 结论、逐项运行时证据与 Chrome 未验收声明；可进入用户配合 Chrome 阶段，不等于允许合并。
candidate: a4e1669
inputs:
  - C 0e4867a fix: close managed request resources before reporting（getExistingCDPSession 拒绝、LeasedCDPSession 订阅登记/释放、async timer rejection、pool settle 等待 termination+onInvalidate）
  - D 2e54b87 fix(pi): emoji-safe slicing, per-field clamp, upfront multi-list budget, real value-block sizing
  - 前序报告（未修改）：docs/exec/browser-independent-acceptance.md（23c3ebd FAIL）、docs/exec/browser-independent-revalidation.md（d607439 增量，备份 tmp/review-d607439/original-independent-revalidation.md）
  - 探针与日志：tmp/review-a4e1669/
prompt: |
  冻结候选 a4e1669 上做收尾复审：只读产品、不 commit/push、默认配置、无
  Chrome/Chromium/headless/浏览器工具、不动 19988 与用户 profile、不做通用
  sandbox 扩展。重跑原 outcome/timer/facade 探针确保无回归；独立验证 C/D
  pending 闭环：getExistingCDPSession 普通路径拒绝、helper 拿 CDP 旧 lease
  不能复活且 on 卸载、async timer rejection 不未处理、pool 延迟 onInvalidate
  与真实子进程 exit-before-response/replacement、D 的 single 巨标题、combined
  lists、emoji/JSON 预算。允许复制探针到 tmp/review-a4e1669/、允许跑目标测试
  文件；不跑全套件与 harness。pending 全闭环则给 nonbrowser PASS、Chrome
  INCOMPLETE、允许进入用户配合 Chrome 阶段（不是允许 merge）。
---

# 结论

- **无浏览器验收：PASS**。原 23c3ebd 的 P0/P1/P2 与 d607439 报告中列出的全部
  known pending（C 四项、D 三项、pool 取消/替换时序）在本候选上均已闭环，
  两项回归探针结果与上一轮完全一致（无回归）。
- **Chrome 阶段：INCOMPLETE（未执行）**。可进入用户配合的 Chrome 验收阶段；
  这**不等于允许合并**（合并仍需 Chrome 验收通过 + 独立复审结论冻结）。
- 范围限制：证据来自真实 WorkerRuntime/Facade/Lease 代码 + 桩 page/CDP 会话、
  真实子进程 fixture、真实本地 HTTP 测试服务器；**没有真实 Chrome**。

# 证据（tmp/review-a4e1669/，ignored 持久保存）

| 探针/日志 | 覆盖 | 关键结果 |
| --- | --- | --- |
| worker-outcome-probe-v2.out.json | 回归 | unknown×2、invalid-request/not-started、stale-snapshot/not-started×2、timer A→B 期间 clicks=0 |
| facade-escape-min-v2.out.json | 回归 | frames/elementHandle 非 raw；close/newPage/browser.close 计数全 0；lease 释放后旧句柄 fail-closed |
| pending-closure-probe.out.json | C | getExistingCDPSession 被拒并指向 helper；CDP helper send/on 成功、请求结束 off=1；旧 session send/on 抛 lease-expired（send 计数不再增长、用户回调 0 次）；async timer rejection 不未处理且被记录 |
| pool-closure-probe.out.json | C/pool | 超时响应 `timeout/unknown`、92ms（≥80ms 延迟回调）、旧 worker 退出文件在响应前已存在；替换 worker 新 pid；`stdin-broken` 退出先于响应 → `outcome-unknown/unknown` 107ms 内返回；随后恢复成功 |
| d-budget-probe.out.json | D | 文本 48,043B 无 U+FFFD；单巨标题块 4,114B 且 tabId/snapshotId 完整；三列表 23,922B 全 key 保留 + 3 个 Truncated；emoji 名称 2,003B 无 U+FFFD；value 块 23,999B |
| targeted-tests.log | 交叉 | `managed-executor-pool/lease` 2 文件 13 用例、pi `test/index.test.ts` 19 用例通过 |

复跑命令（默认配置、无 Chrome）：

```
pnpm exec tsx tmp/review-a4e1669/worker-outcome-probe-v2.mts
pnpm exec tsx tmp/review-a4e1669/facade-escape-min-v2.mts
pnpm exec tsx tmp/review-a4e1669/pending-closure-probe.mts
pnpm exec tsx tmp/review-a4e1669/pool-closure-probe.mts
pnpm exec tsx tmp/review-a4e1669/d-budget-probe.mts
pnpm --filter @tom-cat/pi-browser-runtime exec vitest run -c vitest.unit.config.ts src/managed-executor-pool.test.ts src/managed-executor-lease.test.ts
pnpm --filter @tom-cat/pi-browser-use-extension exec vitest run test/index.test.ts
```

# pending 闭环明细

1. `context.getExistingCDPSession`：facade 直接 forbidden 并提示
   `use getCDPSession({ page })`（探针读到该消息）——普通路径不再泄漏 raw。
2. CDP 订阅生命周期：helper 返回 `LeasedCDPSession`，`on` 登记 lease 守卫的
   wrapper；请求 finally 逐个 dispose → 底层 off（探针 off=1）；释放后旧句柄
   `send`/`on` 抛 lease-expired，注册过的 wrapper 即使被底层 session 调用也不会
   触发用户回调。
3. async timer rejection：`timerCallback` 捕获同步 throw 并 `Promise.resolve`
   捕获异步 rejection（探针 unhandledRejection=0，且记录
   `request-scoped timer callback failed: async-timer-boom`）。
4. pool 时序：active 任务在 termination + onInvalidate 完成后才 settle
   （超时探针 92ms ≥ 80ms 回调且旧进程 exit 文件已存在）；同 key 替换前会等待
   tracked invalidation（`getOrCreateWorker` 入口 await）。原“取消后新旧 worker
   并存”的 P2 随之关闭。worker 退出先于响应 → `outcome-unknown/unknown` 且不
   冒充 timeout，池随后可正常重建。
5. D 输出预算：emoji 边界不产生 U+FFFD；单资源巨标题/URL 被逐字段 clamp
   （id 永不被截断）；多列表预先预留 overhead，全 key 保留且 JSON 有效；
   value 块用真实 header/footer 字节计算，整体 ≤24k。

# 未覆盖与限制

- 真实 Chrome 全链路（扩展加载、debugger、真实标签/弹窗、真实 Playwright
  动作与超时）仍未验证；所有结论仅限无浏览器范围。
- 全套件重跑与 acceptance harness 由协调者负责（harness 正在由 CodeBuddy16
  小修，未审）。
- C 新增 changeset 引用旧包名 `playwriter` 的问题已在 integration 修正为
  `@tom-cat/pi-browser-runtime`，属元数据、非产品缺陷。
- 原 FAIL 报告与 d607439 增量报告均未改动；本报告是新增的收尾记录。
