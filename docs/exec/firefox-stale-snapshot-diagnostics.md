# Firefox stale-ref 有界原因诊断

0.0.137。分支 `fix/firefox-snapshot-diagnostics`，基于 `0d91d79`。范围只有可观测性，
不是对未复现 stale 的修复。

## 背景

0.0.137 完整实机验收中，新建标签后 `snapshot`（耗时 1118ms）→ 40ms 后按 ref `page.fill`
偶发 `code:"stale-snapshot"`、`outcome:"not-started"`（1/4 完整运行）。随后 18 个固定样本
定向诊断 0 次复现（0/18），因此不能判定为误失效，也不能断言 DOM 未变或必然为注入竞态，
根因 UNDETERMINED。原错误只输出 "missing or stale"，缺少内部原因可供下轮区分。

## 改动

只在 `extension/src/firefox-dom.ts` 闭包内：

- `invalidate()` 接受 `SnapshotInvalidationReason` 并在清除 snapshot 前，把
  **最近一次**被失效的 `snapshotId` 与枚举原因记入单个 `lastInvalidation`。不保存
  MutationRecord、DOM 节点、文本/属性值或 URL；不新增 timer、全局状态或权限。
- 所有失效点带原因：mutation observer 与 `flushMutations` → `dom-mutation`；
  `pagehide`/`popstate`/`hashchange` 及 `document.URL` 变化 → `navigation`；
  `action`；`evaluate`；`dispose`；`invalidate` 命令 → `explicit-invalidate`。
  `pagehide`/`popstate`/`hashchange` 改为同一个 `onNavigation` listener，add/remove 成对。
- `resolveRef` 在仍满足原拒绝条件时，`error.message` 追加 `reason: <enum>`：
  `missing-snapshot-id`、`snapshot-replaced`、`ref-not-in-snapshot`、`different-document`
  （snapshotId 前缀的 documentId 不属于本 driver）、`element-detached`、
  `element-document-changed`、`invalidated:<原因>`，无法对应时明确 `unknown`。
  只关联确实等于请求 `snapshotId` 的失效记录；不猜测页面没变或必然某场景。

`code`、`outcome` 与全部拒绝条件不变；不自动刷新/重试/复活 refs，不把 DOM 变化改为可接受，
不改 snapshot 生命周期与 ownership，无协议/manifest/CSP 变更。

## 测试

`extension/tests/firefox-dom.test.ts` 新增 `Firefox DOM stale snapshot diagnostics`，用真实
JSDOM DOM、mutation 与 driver 调用覆盖缺失 snapshotId、ref 不在快照、快照被替换、DOM
mutation、navigation 事件、显式 invalidate、evaluate、action 与跨文档 driver 九种原因；
每个用例同时断言原 `stale-snapshot`/`not-started` 拒绝仍在。未 mock 浏览器 API、未伪造
Firefox 事件循环、未加代码注释、未写 inline snapshot。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| 扩展 TypeScript（`tsc --project .`） | PASS |
| `vitest run tests/firefox-dom.test.ts` | PASS，60 tests（新增 9） |
| 扩展完整测试（`vitest run`） | PASS，139 tests / 8 files |

未启动/操作浏览器、runtime、用户设置或已有标签。此改动只让 stale 原因可观测，
**不声称修好了尚未复现的 stale 问题**。
