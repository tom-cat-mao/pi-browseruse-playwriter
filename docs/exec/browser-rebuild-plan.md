---
title: Pi Browser Use 重构计划与并行执行方案
description: 同仓库维护 Pi 工具与 Playwriter 派生底座，先实现再独立验收。
prompt: |
  用户原始执行要求：
  我觉得可以，还有什么需要讨论的吗
  如果没有的话可以开始工作了
  你来写计划书以及执行的方案
  可以分为多个step
  可以分的很细，然后让多个codebuddy, traex, codex形成类似于swarm的形式，
  同步进行修改
  完成之后再发出一个全新的 agent去进行验收，最后合并。
  最后完成这个巨大的任务就可以
  后续约束：
  然后如果需要chrome的时候你可以告诉我停下来，然后打开一个我来配合你
  不要wait agent就好了
  多agent合作的时候记得开多个worktree，最后记得合并和清理。
  不要直接在main上干，要进入开放的branch然后提pr
  依据 @README.md @playwriter/src/skill.md @pi/extensions/index.ts
  @pi/extensions/bootstrap.ts @pi/extensions/relay-client.ts
  @extension/src/background.ts @playwriter/src/cdp-relay.ts
  @playwriter/src/executor.ts @playwriter/src/relay-state.ts
  @playwriter/src/start-relay-server.ts @playwriter/src/create-logger.ts
  @playwriter/src/cdp-log.ts @.github/workflows/ci.yml
  @docs/exec/browser-runtime-contract.md @playwriter/src/browser-protocol.ts
  及本会话已经确认的需求完成实施。
---

# 决策与范围

本文件及 browser-runtime-contract.md 取代旧的 A/B/C 执行计划。
旧分支 feat/ext-session-groups-consent 保留参考，不直接合并。

- 同一仓库、独立模块、独立进程；本轮继续使用 TypeScript。
- Pi 是 agent，browser-use 只是工具。禁止新增业务工作流、验证码检测、
  专用 HITL 按钮、自动重放提交/发送、按业务危险程度弹确认。
- Pi session UUID 由 Pi 注入，不由 LLM 填写。
- 一个 Pi session 拥有多个命名分组；组只属于一个 session。
- LLM 创建分组必须提供名字；复用组显式指定 groupId。
- 每个组绑定一个 profile；一个 session 可跨多个 profile。
- 标签操作显式传 tabId。逻辑 ID 与 Chrome/CDP 的临时 ID 分离。
- 默认新建任务标签。组/标签列表仅列本 session 所属资源。
- 新标签必须完成登记、入组再返回成功。任务 popup/新链接继承源组。
- 不要求用户选择窗口，但每个实体 Chrome 分组属于一个窗口；
  新标签和任务 popup 应放到目标组窗口，不能靠最近聚焦窗口猜测。
- relay/WS 断开、Pi 退出、任务完成，不解除分组，不删除归属。
- 用户拖出或取消控制意味着释放控制；断线期间也必须记录，不能拉回。
- 只恢复连接和资源绑定，不自动重放浏览器业务动作。
- Chrome 整体重启不能只按 URL/名称猜归属；无法核验时标为需重新绑定。
- 明确关闭指令只作用于当前 session 的资源，不影响其他组或用户标签。

# 基线与 Git 工作流

- 原 main：8cbf68b；上游快照：6e563c86eb1a。
- 集成分支：feat/pi-browser-rebuild。
- 集成工作树：tmp/swarm-rebuild/integration。
- 主目录 main 不写入功能代码；保留 docs/exec/ppe-accept.jpg。
- 集成分支已合并最新上游，保留其修复与 Git 历史。
- 每个执行 agent 独立 worktree，文件所有权互斥。
- 用户授权本任务创建工作分支、提交、汇总提交及向 origin 发起 PR。
- 禁止向 remorses/playwriter 提 PR/推送。所有 gh 写操作必须显式：
  -R tom-cat-mao/pi-browseruse-playwriter。
- 功能分支内可以提交；main 仅在独立验收和用户 Chrome 验收通过后合入。
- Chrome 未验收时仅 draft PR，绝不宣称全绿或提前合并 main。
- 不发布 npm、不发布 Chrome Web Store、不强推、不替换日常 relay。

# 模块职责

## Chrome extension

本 profile 的分组归属注册表是权威来源，保存在 extension storage。
负责 Chrome 资源创建、分组、释放、对账；连接状态不决定资源归属。
所有恢复先读取持久记录，再检查实际 Chrome tab/group 和启动 epoch。

## Runtime / relay

跨 profile 目录、session 所有权检查、连接 epoch、请求调度、结果结构化。
不重新从 URL/组名或首个 CDP 命令推导归属。断线不删除持久资源。
legacy WS/CDP 保持兼容；managed API 走新增命名空间，缺能力明确报错。

## Isolated executor

独立 Node 子进程运行 Playwright；每个 session/profile 隔离执行实例。
复用现有 Playwright、AX snapshot、CDP、iframe 支持，不重写浏览器引擎。
结构化动作直接调用 API，不能经 console marker 字符串往返。
超时终止旧执行进程/控制通道；已发送动作可能完成，返回 unknown outcome。

## Pi package

薄工具层：schema、参数、原生 session ID、返回结果/图片、取消信号。
无浏览器业务判断，正常 shutdown 仅释放执行资源，不删除组和标签。
使用配套 fork runtime，不调用 npx playwriter@latest，不改运行中的配置。

# Step 0：契约与环境（协调者）

- [x] 核验 main、上游与已有工作树。
- [x] 创建独立集成工作树，合并上游到功能分支。
- [ ] 固定新增 API / WS / executor 共享类型。
- [ ] 创建全部执行 worktree；每项指定唯一 owner。
- [ ] 记录工具链和 Chrome 验收门槛。

# Step 1：并行实现

## A / CodeBuddy：浏览器归属与生命周期

所有权：extension/src/**、extension/manifest.json、extension 测试。

1. 新建可测的资源注册表与归属状态转换模块。
2. chrome.storage.local 持久资源，storage.session 标识本浏览器运行期。
3. WS 重连与 SW 重启先恢复资源，再恢复 debugger attachment。
4. 拆分 transient detach、用户释放、实际 tab close。
5. 新增命名组、创建标签、rename、close、release、resolve 控制协议。
6. source tab -> group 处理 target=_blank、popup，排除无关用户 popup。
7. 内部移动标记与用户移动分开，释放 tombstone 防止重连反向覆盖。
8. 同名组不合并、不按标题识别；失败不假装创建成功。
9. 状态转换纯函数测试；等待 Chrome 授权后再做 Chrome 测试。
10. bump extension manifest；只归属 A 修改版本。

## B / CodeBuddy：managed relay 与作用域路由

所有权：playwriter/src/cdp-relay.ts、relay-state.ts、新 managed relay 模块。

1. /browser/v1/capabilities、profiles、request 新接口与运行时校验。
2. 维护 profile 快照缓存；extension inventory 是资源事实来源。
3. 绑定 session/profile/worker，检查 group/tab owner，拒绝跨 session。
4. managed CDP 仅暴露当前 session 的合法 targets；legacy 路径不变。
5. group/tab 管理委托 extension 原子操作，不使用 FIFO/首触猜归属。
6. worker/WS epoch 防止旧连接回调污染新状态。
7. 调用 C 的 executor pool，连接关闭/显式取消时撤销控制通道。
8. 每 profile 输入互斥、每 worker 执行串行；只做技术调度。
9. profiles 多选明确指定，无兼容能力时拒绝 managed 功能。
10. 无浏览器 HTTP/WS 集成测试、权限与隔离测试。

## C / Codex：独立执行器与结构化动作

所有权：playwriter/src/managed-executor*.ts 及相应测试、新 worker 文件。

1. 实现共享契约中 ManagedExecutorPool，支持编译产物及本地源码运行。
2. 独立进程、会话/profile 定位、明确 targetId 查 page。
3. snapshot/click/fill/evaluate/screenshot/network/logs/execute 动作。
4. snapshot refs 按 page+generation 管理，跨页或过期不能静默 first()。
5. fill 前正确聚焦，输入与显示结果验证按 API 语义而非业务判断。
6. raw execute 仅获得本 session 控制页面，不能借 context 创建无归属 tab。
7. worker timeout/abort 终止执行，输出 outcome_unknown，不自动重放。
8. 返回结构化 result/日志/图片/工件，不解析 console marker。
9. 控制输出大小、监听器归属及缓冲上限；disconnect 不关闭用户 Chrome。
10. 使用真实子进程的无浏览器测试验证超时后无新指令。

## D / TRAEX：Pi 工具重构

所有权：pi/extensions/**、pi/test/**、pi/skills/**、pi/README.md。

1. 所有工具使用共享 managed API；删除旧 snippets/默认 page 假设。
2. browser_profiles、browser_groups、browser_tabs、显式 tabId 动作。
3. 原生 Pi sessionManager.getSessionId() 注入每次请求。
4. 初次 group create 必须有 name；多组通过 groupId 复用。
5. 透传 signal、请求 ID、cwd；取消不重放动作。
6. 错误展示明确，text / details / image 内联内容一致。
7. shutdown 只 release executor，不清理浏览器分组。
8. bootstrap 仅启动配套 runtime，/browser-status 为只读查询。
9. skill 保持简短，业务/HITL 交给 Pi 本身。
10. HTTP 契约与参数测试、jiti 加载检查；不启动真实 Pi agent/browser。

## E / CodeBuddy：工具链、发布边界、日志与启动可靠性

所有权：package manifests、workspace/lock、构建脚本、CI、README、
playwriter/src/{utils,relay-client,start-relay-server,create-logger,cdp-log}.ts。

1. 固定实际可用的 pnpm 版本，修 workspace 安装与构建，不全量升级依赖。
2. 后台包名称 @tom-cat/pi-browser-runtime，保留现有源码目录。
3. own executable pi-browser-runtime；管理模式默认独立端口 19989、
   独立 ~/.pi-browser-use 数据目录，环境 PI_BROWSER_*。
4. fork 扩展独立开发 key 与 origin 允许列表，通过集成协调 A 更新。
5. 客户端不按 package 版本杀共享进程；capability 协商代替盲目重启。
6. 明确 port/token/config 启动链路，修 detached token 丢失。
7. 文件日志失败不 poison queue/不退出 relay，限制积压与文件增长。
8. CI 真正执行 typecheck、纯测试、构建；Chrome 作独立授权阶段。
9. 依赖声明用 pnpm 操作，生成锁文件；不手写 dependency 版本。
10. 文档与发行包 smoke check；不执行发布。

# Step 2：协调者集成

1. 各 agent 提交完整代码、changeset、测试结果、已知缺口。
2. 协调者逐项检查实际 diff，不能仅相信 agent 报告。
3. 合入集成分支，协调共享导出、imports、manifest、lockfile。
4. 解决跨层契约偏差；源码和运行类型必须一致。
5. 从干净依赖和构建链路执行静态/无浏览器验收。
6. 按实际证据更新进度，不把 skipped 当 passed。

# Step 3：全新 agent 独立验收

实现 agent 不能担任最终验收者。创建全新 CodeBuddy/Codex 会话，
仅提供需求、契约、源码和测试命令，不用实现者总结替代检查。

- 所有权、断线生命周期、取消与异常结果、协议兼容、资源泄漏。
- 对实际补丁找问题并独立重跑检查。
- 发现问题退回 owner 修复，再验收。
- 新增无浏览器对抗场景，不用 mock 隐藏接口问题。

# Step 4：用户配合 Chrome 验收（必须停下来）

任何 agent 需要 Chrome 前通知协调者。协调者向用户说明构建路径、
测试 profile、端口、需要加载的扩展，用户打开后才继续。
不调用日常 browser 工具，不碰 19988，不关闭用户 Chrome/context。

验收矩阵：

1. session A 两个不同名组；session B 一个组，互不可见/操作。
2. 两个 profile 同时连接，包含同账号/无登录身份情况，不串资源。
3. 新标签、target=_blank、OAuth popup 全部进入正确组。
4. 分组重名、用户改名，不改变 owner，不合并组。
5. 中断 WS、停止测试 relay、重启测试 relay：组不散、不重复建。
6. extension SW 重启/扩展重载：可验证的原资源恢复，其他资源不接管。
7. 离线时拖出标签，重连不拉回；最后一张标签拖出也正确释放。
8. 执行中取消/超时：无后续旧指令，已发动作结果不明如实报告。
9. Pi 退出/恢复原 session：分组保留；新 session 不自动接管旧组。
10. 关闭本组不影响其他组/借用标签；浏览器完整重启不靠 URL 猜身份。
11. SPA、iframe、截图、输入、network/logs 基础回归。

# Step 5：PR 与清理

- Chrome 前可以创建 draft PR，明确未验收项。
- 独立 review + Chrome 验收全部通过后，更新 PR 为可合并状态。
- 最终合并以用户授权和仓库规则为准；不绕过检查。
- 归档独有产物后删除 swarm 工作树，保留 PR/提交历史。
- 主目录仅在最终合并后更新；Pi 加载路径保持主目录，不临时指向 worktree。

# 执行纪律

- 只使用 CodeBuddy、TRAEX、Codex；优先 CodeBuddy，禁止 Reasonix。
- 不调用 external_agent_wait，不 sleep 轮询，靠完成通知推进。
- 进度以提交/测试证据记录，不承诺未验证的浏览器效果。
- 不运行 pnpm dev，不运行以 & 结尾的后台 shell。
- 不改用户 settings，不碰真实浏览器和 19988。
- 新 TS 函数多参数采用 object；禁止新增 any、静默 catch、多余注释。
- tests 从包目录 --run，快照只能工具生成并读回检查。
- public package 变更配 changeset；issue 查询已执行，fork 禁用 issues。
