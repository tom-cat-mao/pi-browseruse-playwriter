# 工作流 C：授权边界 + 审计 + localhost token（relay 侧）

目标：给 relay 补社区信任门槛。与 B 同 worktree、同 agent 顺序执行（都主要改 `cdp-relay.ts`，避免并行冲突）。

## C1 per-host 授权门（consent）

- 配置文件 `~/.playwriter/consent.json`：`{"allow": string[], "block": string[]}`，host 模式（支持 `*.example.com` 后缀通配）。文件不存在=空配置=全放行（保持现状，不破坏上游用户）。每次请求热读（不缓存），解析失败按"空配置+警告日志"处理。
- 执行点：`POST /cli/execute` 前，解析该 session 当前 page 的 URL → host 判定：**block 优先**；allow 非空时仅放行 allow 命中。拒绝返回 403 + 可操作错误（说明被哪条规则拦、配置文件路径、格式示例）。
- execute 完成后复查最终 URL（防 goto 绕过）：命中 block → 返回结果中追加醒目警告文本并记录审计（不强制 detach）。
- `GET /cli/capabilities` 的 `consent` 字段置 true。

## C2 审计环形日志

- 每 session 内存环形缓冲（100 条）：`{ts, sessionId, code（截前 500 字符）, urlBefore, urlAfter, durationMs, isError}`。
- `GET /cli/session/audit?sessionId=<id>`（缺 sessionId 返回所有 session 的）。`/cli/session/delete` 时一并清。
- capabilities 的 `audit` 置 true。

## C3 localhost token（可选加固）

- relay 启动读 `PLAYWRITER_TOKEN` env（或 serve --token 已有逻辑对齐）：设置后，**包括 localhost** 的 `/cli/*` 全部要求 `Authorization: Bearer <token>`；未配置则行为与现状完全一致（零破坏）。
- README（仓库根 README 新增一节，不动原有内容）：威胁模型 3-5 句（localhost 裸奔风险 → token；consent 的边界——只约束 agent 通道，不替代浏览器自身安全）。

## 不变量与测试

- 无 consent.json / 无 token 时行为与上游完全一致（回归测试）。
- C1 判定逻辑抽纯函数配 vitest：host 匹配（精确/通配/大小写/带端口）、block 优先、allow 空与非空矩阵。
- C2 环形缓冲满溢、并发写、delete 清理。
- C3 带/不带 token 两态测试。
- `pnpm --filter playwriter test` 全绿。

## 验收

1. 单测绿；`pnpm --filter playwriter build` 成功。
2. 起测试 relay（非 19988 端口）：写 consent.json block `*.tiktok.com` → execute 命中 403 且错误文本含规则与路径；allow 单 host 时其他 host 被拒。
3. audit 端点返回执行记录；token 设置时无 Authorization 头 → 401。
4. 报告按 00-overview.md 格式。
