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
