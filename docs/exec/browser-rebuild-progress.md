---
title: Pi Browser Use 重构执行进度
description: 工作树、任务归属、合并顺序与验收状态。
prompt: |
  按用户授权的多 agent worktree 工作流记录实际进度。
  参考 @docs/exec/browser-rebuild-plan.md
  @docs/exec/browser-runtime-contract.md @playwriter/src/browser-protocol.ts。
  只记录已执行事实；不得把未执行 Chrome 验收标为通过。
---

# 当前阶段

Step 1/2：五条工作流并行实施并滚动集成。尚未进行 Chrome 验收。
用户明确要求不阻塞等待 agent，需要 Chrome 时通知用户后停下。
全部执行 agent 使用默认 model/effort；禁止 Reasonix。
codebuddy-6 原先显式 effort=high，已依用户要求停止，由默认配置的
codebuddy-11 接续同一工作树，保留未提交修改。其余四个执行 agent 均未
指定 model/effort，无需重启。

# 任务与所有权

| 工作流 | agent / task | 分支 | 状态 |
| --- | --- | --- | --- |
| E 工具链/发行/日志 | CodeBuddy / codebuddy-11 | feat/browser-runtime-foundation | 2346d18 已集成，CI待重跑 |
| A 扩展归属/分组 | CodeBuddy / codebuddy-7 | feat/browser-owned-groups | 42eb198 已集成 |
| B Managed relay | CodeBuddy / codebuddy-8 | feat/browser-managed-relay | 107d274 已集成，worker静态接线完成 |
| C 独立执行器 | Codex / codex-9 | feat/browser-isolated-executor | f37b70b 已集成 |
| D Pi 工具 | TRAEX / traex-10 | feat/browser-pi-tools | 6dcde8e 已集成 |
| 集成/共享契约 | 协调者 | feat/pi-browser-rebuild | 进行中 |
| 中期独立审查 | 全新 CodeBuddy / codebuddy-12，只读 | 集成分支 | 已完成，见browser-midpoint-review.md |
| 验收脚本准备 | 新 CodeBuddy / codebuddy-13 | feat/browser-acceptance-harness | 54c1f07已集成，说明/严格类型修订中 |
| 最终独立验收 | 全新CodeBuddy / codebuddy-14 | review/browser-rebuild | FAIL：C outcome/残留回调阻塞，Chrome未开始 |

各 worktree 位于主仓库 tmp/swarm-rebuild/：foundation、extension、relay、
executor、pi-tools、integration。主目录 main 未修改。

# 已完成

- 主目录 main 8cbf68b，未跟踪 ppe-accept.jpg 保留。
- 集成分支合入上游 6e563c8，合并提交 f7cef2d。
- 计划、契约、共享类型提交 859910d。
- 独立 tsc 检查 browser-protocol.ts 通过。
- 已创建五个实现 worktree 并派发任务；没有等待 agent。
- fork origin = tom-cat-mao/pi-browseruse-playwriter。
- gh 默认仓库可能指向上游，所有后续 GitHub 操作显式 -R fork。
- fork issues 禁用；参考上游 issue 时使用完整来源，不发上游 PR。
- E 基础设施 1107228 已合入集成分支；A 主体 20c5fb5/bf29f36 已合入。
- 集成工作树 pnpm 10.18.1 frozen install 成功；Playwright 子模块已本地
  reference 初始化到2074cbb1d并保持playwriter分支。
- 协调者在集成树重跑 runtime build + test:unit：28/28通过，无Chrome。
- E 复核要求：并发启动不truncate日志、非法HTTP不判down、endpoint隔离、
  token子进程测试、fork默认构建命令不能指向上游ID/19988/商店。
- A 复核要求：持久化失败不假ready、scoped持久去重、per-group并发、
  用户释放时失败cleanup不删用户tab、旧epoch数字不访问Chrome、
  popup先归属/入组再attach、用户改名事件、全局取消不自动重控。
- B 543b636已合入：CDP URL token、request指纹去重、tab.resolve已实现。
- 协调者再次在集成树跑 typecheck，runtime 123/123测试、extension
  11/11纯状态测试通过（无Chrome）。
- E追加7d0f92b已合入：非破坏日志、端点分类、真实token/并发启动测试。
- B二审要求：root/nested CDP绕过防护、parent释放即撤销iframe权限、
  流式body限额、队列执行前再校验owner/epoch/释放。
- E二审要求：ownbin不覆盖全局playwriter、production fork不退19988、
  CI加入各新模块/Pi/extension测试、logger序列化与既有文件计量。
- A b3fa70b、B0364558、E4500349已合入；协调者重跑 runtime build、
  249/249无浏览器runtime tests、23/23extension state tests。
- Pi旧原型59/59测试和typecheck仍过，但D新版尚未合入，这不是新版验收。
- 已创建Draft PR #1：
  https://github.com/tom-cat-mao/pi-browseruse-playwriter/pull/1
- 首次push7a5fb61的GitHub CI通过。
- 1583c00两次Linux CI在Vitest进程池报ERR_IPC_CHANNEL_CLOSED，已交E
  查明根因，不能以本地通过替代。GitHub run34464546572/34464543374。
- B3909817已合入：控制取消转发、矛盾inventory拒绝、nested CDP包装拒绝。
- 独立acceptance工作树现为feat/browser-acceptance-harness；新CodeBuddy13
  编写带显式授权门槛的Chrome验收脚本（只准备/dry-run，不启动Chrome）。
  最终验收须在C/D完成后另开新agent针对冻结候选提交进行。
- 中期全新CodeBuddy只读审查已启动，避免实现者自验收。
- 契约补全控制请求取消必须透传extension、旧WS代际结果不得送新socket、
  pending/completed create ledger防SW中断重复创建；A/B在各自分支落实。
- E2346d18已合入，明确将locator-selector.test.ts移出无浏览器套件；
  此前249项及部分回归包含该测试，它实际上启动过隔离headless Chromium。
  协调者已向用户更正；未访问日常Chrome或重启19988。不能将此前执行
  统称为纯无浏览器。后续逐项检查套件并按授权门槛运行。
- Linux另一个IPC崩溃原因仍为端口/进程并行竞态推断，串行分离后待CI验证。
- 纠正测试分类后，协调者重跑实际无浏览器套件：runtime unit210/210、
  process integration34/34、extension33/33通过；typechecks通过。
  e979d37已push PR，Linux CI待结果。
- A35fe197已合入：请求取消跟踪、pending ledger、revision fence。
  最后read-back要求覆盖所有CDP reply（不只browserRequest）、取消优先于
  programmatic抑制、旧storage写drain、权威tab.resolve核验实际分组。
- C f37b70b与D6dcde8e已集成；协调者重跑候选：runtime217unit+34
  process integration、Pi48+12工具loadcheck、extension34全部通过。
- e979d37 Linux CI一条success一条failure，B已查明是测试两个并发fetch
  到达顺序不定；先确认queue-a握手再发queue-b后，Node22目标case10次、
  整套unit218项3次通过。107d274静态worker接线和确定性测试已合入。
- d37ea7a两次Linux CI均通过，最新107d274集成尚待重跑。
- 验收脚本54c1f07已集成，尚未对真实browser API执行。
  协调者修订要求：token示例、SW restart与extension reload区分、
  fault流程资源不提前cleanup、去掉noImplicitAny=false假严格检查。
- fork签名私钥已复制到主目录ignored tmp/swarm-rebuild-artifacts，
  权限600，内容校验一致，不公开不提交，避免清理worktree丢失。
- 全新最终reviewer CodeBuddy14在review/browser-rebuild独立树，
  候选23c3ebd；Chrome仍未授权，结果最多是非浏览器验收。
- 全新CodeBuddy14最终独立验收FAIL（候选23c3ebd），报告在
  docs/exec/browser-independent-acceptance.md。真实worker+桩page探针确认
  P0副作用后not-started错误、P1成功脚本残留timer跨请求发指令；C修订中。
- reviewer其余测试重跑通过不抵消P0/P1，Chrome阶段INCOMPLETE。
- 最新静态worker接线后协调者build/smoke、unit218、integration34通过。
- 以上不能代替用户Chrome验收，不提前merge main。

# 待完成门槛

- [ ] 五个 owner 提交及真实无浏览器验证结果。
- [ ] 集成跨层接口、类型和依赖配置。
- [ ] 独立全新 agent 代码审查及无浏览器验收。
- [ ] 用户配合加载测试 Chrome 扩展。
- [ ] 多 profile/多组/断线不散组/用户释放 Chrome 验收。
- [ ] origin draft PR -> 验收完成后就绪 -> 最终合并。
- [ ] 归档独有产物，清理所有 swarm worktree。

# 不可越过

未获用户配合前：不启动 Chrome，不调用用户 browser 工具，不动19988。
未验收完成：不合入 main，不宣称完成，不发布 npm/Chrome 商店。
