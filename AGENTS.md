# Pi Browser Use 仓库开发指引

本文件是本仓库唯一的 agent/开发者指引，直接在此维护，不再由脚本生成，也不要再新增
core.md 之类的并行副本；PLAYWRITER_AGENTS.md 仅为兼容旧链接保留的指针。旧版内容通过
Git 历史保留。

## 产品与目录

Pi Browser Use（tom-cat-mao/pi-browseruse-playwriter）是 remorses/playwriter 的维护
fork，保留 MIT 许可与上游署名。它让 Pi agent 通过本机 Chrome 扩展操作用户真实的标签
与登录态；浏览器不离开本机，也没有云端浏览器。

当前没有任何 npm 发布，也没有 Chrome Web Store 上架：不要写"已发布"，不要使用旧商店
ID。fork 开发扩展 ID 是 `eeklahpecooapnailfaebkjjembkjhhg`，不是上游的
`jfeammnjpkecdekppnclgkkffahnhfhe` / `pebbngnfojnignonigcnkdilknapkgid`。

| 路径 | 包 | 说明 |
| --- | --- | --- |
| playwriter/ | @tom-cat/pi-browser-runtime（public） | managed runtime / relay / executor / 协议类型 |
| extension/ | mcp-extension（private） | 用 chrome.debugger 管理用户浏览器的 Chrome 扩展 |
| pi/ | @tom-cat/pi-browser-use-extension（public） | Pi 工具 + 模型侧使用说明 |
| playwright/ | @xmorse/playwright-core（子模块） | remorses/playwright，固定 playwriter 分支 |
| website/、db/ | 上游遗留 | cloud/D1/网站代码，与当前产品无关，除非用户明确要求，不要投入 |

`docs/exec/` 混合契约、计划与验收记录：其中的计划和旧验收只属于具体任务的历史上下文
（含被取代的 A/B/C 方案与过期失败记录），不是长期指令，契约与代码才是权威；`docs/`
下的其它文件、`slop/` 属于历史/上游资料。

扩展与 runtime 的 WS 协议必须向后兼容：扩展的加载/发布永远滞后于 runtime 与本地安装。
编译契约的唯一来源是 `playwriter/src/browser-protocol.ts`，协议变更只能是可选、追加式
字段；先改该文件，再做各端适配。

## 资源模型与既有行为

- 身份：Pi session UUID 由 Pi 自动注入，不是 LLM 参数；groupId/tabId 是不透明逻辑
  ID，不等于 Chrome 数值 ID；profileId 是扩展生成的安装身份。
- 归属：一个 Pi session 对应多个具名 group，每个 group 绑定一个 profile；所有页面操作
  必须携带显式 tabId。扩展是资源归属的事实来源，relay 只做校验与缓存，不自行推导。
- browserEpoch 标识一次 Chrome 运行期；revision 单调递增；release 是 tombstone，
  防止重连把用户已放手的标签拉回来。不得按 URL/标题/组名推断归属，不得 pages[0]/
  last tab，不得复活旧的单窗口假设或全局共享 page 模型。
- 既有能力：profiles 只读（list）；groups 可 list/create/rename/close；tabs 可
  list/create/close/release；tabs.discover 与 tabs.attach 原地接管用户现有标签
  （不刷新、不搬窗口、保留滚动与表单）；sourceTabId 关联外链新开的标签；
  tabs.activate 切回原标签；page.back 走真实浏览器历史；snapshot 返回 snapshotId
  与 shortRef，click/fill 使用 ref 时必须带 snapshotId；普通 CSS/role selector
  严格匹配、无 `.first()` 回退；execute 在隔离 worker 中执行；取消/超时不重放，
  已开始的动作如实返回 outcome unknown。
- Pi 展示与模型可见内容是两回事：稳定 ID、evaluate 返回值、错误详情必须进入
  model-facing content，`details` 只给 UI。`page.evaluate` 必须显式 return；任何
  evaluate/execute 之后 ref 保守失效，需要重新 snapshot，不能猜只读而跳过验证。
- 计划不等于已交付：`docs/exec/browser-reliability-plan.md` 等描述的是进行中的工作；
  不要把未合入的功能写成既有行为。
- 不要复活：旧 consent/audit/PDF 工具、网站/D1/cloud 业务逻辑、业务 agent、CAPTCHA/
  HITL 流程。这里只有浏览器工具；出错只修根因，不靠扩大控制范围或放宽校验来"修"错误。

## 端口、数据与用户环境

- managed runtime 默认 `127.0.0.1:19989`，数据目录 `~/.pi-browser-use`；可用
  `PI_BROWSER_HOST` / `PI_BROWSER_PORT` / `PI_BROWSER_TOKEN` / `PI_BROWSER_DATA_DIR` /
  `PI_BROWSER_LOG_FILE_PATH` / `PI_BROWSER_CDP_LOG_FILE_PATH` 覆盖。默认日志位于该数据
  目录下的 `relay-server.log` 与 `cdp.jsonl`。
- `19988` 与 `~/.playwriter` 属于 legacy relay，不是本产品。绝不 blanket kill 或重启
  任何端口上的进程；先 lsof 查看，再和用户确认。
- 不要改动用户正在使用的 Pi 安装/设置、runtime、已加载扩展。需要改设置、安装、重载
  扩展或重启 runtime 前，先说明理由并得到用户同意；也不要自动运行 `pnpm reload` 或
  `pnpm dev`。
- 不要用源码 symlink 把 agent 的改动实时接到用户正在运行的安装上；不要把运行状态
  （PID、临时端口、一次性进程）硬编码进代码或文档。
- 不删除不属于你的未跟踪文件、被 ignore 的兼容路径或历史验收产物（例如某些 worktree
  里的 `docs/exec/ppe-accept.jpg`）；清理前先确认是否仍被运行期引用。私有签名密钥
  永远不进仓库、日志或打包产物。

## 环境准备与命令

要求 Node >= 20、pnpm 10.18.1、Bun；只有浏览器阶段才需要本机 Chrome。
新 worktree 第一次工作前：

```bash
pnpm bootstrap
pnpm --filter @tom-cat/pi-browser-runtime build
```

`pnpm bootstrap` 会初始化 playwright 子模块并构建本地 playwright-core。子模块固定在
记录 SHA 的 `playwriter` 分支：不要 pull upstream、切 main，或随手升级。

浏览器无关检查（与 `.github/workflows/ci.yml` 一致，都在包目录内运行）：

```bash
pnpm --filter @tom-cat/pi-browser-runtime typecheck
pnpm --filter @tom-cat/pi-browser-runtime test:unit --run
pnpm --filter @tom-cat/pi-browser-runtime test:integration --run
pnpm --filter mcp-extension test --run
pnpm --filter mcp-extension exec tsc --project .
pnpm --filter @tom-cat/pi-browser-use-extension test --run
pnpm --filter @tom-cat/pi-browser-use-extension typecheck
pnpm --filter @tom-cat/pi-browser-use-extension load-check
```

- 一次构建 runtime 与扩展：`pnpm build`（runtime 构建会生成 `playwriter/dist/extension`）。
- 本地打包扩展（需要先有 `playwriter/dist/extension`）：`pnpm package:extension`，
  产物在 `dist-release/`（ZIP + `.sha256`）；`pnpm release` 是同一步骤的别名，只做本地
  打包，不发布。
- 扩展开发构建：`pnpm --filter mcp-extension build`（fork 身份 + 19989，输出
  `extension/dist`），只构建，不自动加载或重载扩展。
- `pnpm reload` 会被 `scripts/legacy-action-guard.mjs` 拒绝，不要绕过；应用 fork 构建用
  `pnpm reload:fork`，它只构建并打印 chrome://extensions 地址，不会启动 Chrome。
- port/process 相关的 unit 与 integration 套件已串行化（`fileParallelism: false`）；
  不要并跑、合并或跳过它们。

## 测试纪律

- 默认 `pnpm test`（@tom-cat/pi-browser-runtime）会启动真实 Chrome
  （如 `playwriter/src/locator-selector.test.ts`）并自带 `-u` 更新快照，不是浏览器无关
  测试。未经用户准备确认，不要跑默认 `test` / `test:watch`。
- 浏览器阶段先通知用户准备并加载扩展；只测本次改动涉及的场景，不跑无关矩阵，不要
  headless 启动浏览器造成意外，不要在测试里 `browser.close()` / `context.close()`。
- 测试只创建自己的 fixture、临时目录与端口，并清理自己创建的资源。
- 新测试不要 mock；只为已有模块/describe 补真实逻辑测试，不写占位测试。
- bash 工具运行测试时把 timeout 设为至少 300s（即 300000ms；该参数单位是毫秒，
  不要写成会被当成 300000 秒的形式）；断言与等待的超时不超过 5s。
- 快照用 runner 的 `-u` 生成，然后必须读回文件、看 `git diff` 再提交；不手工写内联
  快照，也不无脑接受全部快照变化。
- 声称"通过"之前必须真的跑过对应的 typecheck/test，并如实报告 PASS/FAIL/SKIP。

## Git、PR 与协作

- 只在独立 feature branch/worktree 工作；多 agent 并行时同一文件同一时间只能有一个
  owner，跨边界先协调。
- 提交只在用户/协调者明确授权时进行，一次授权不自动延续到后续分支或任务；不
  reset/revert 用户或其他 agent 的改动；不 force push。
- PR 默认 base 是 `dev`；未经用户明确授权不合 main、不直接提交 main。发布相关操作
  （tag push、GitHub Release、npm、Web Store）只有用户明确授权才能做。
- 所有 `gh` 命令显式 `-R tom-cat-mao/pi-browseruse-playwriter`；fork 的 issues 已禁用，
  不要引用 remorses 上游的 issue。
- 外部 agent 只用 codex / traex / codebuddy，model 与 effort 用默认值，不要改用
  reasonix；不要用 external_agent_wait 或 sleep 轮询等待，完成通知用回调，沟通用
  steer/follow-up。
- 临时文件写到 `./tmp`（已在 .gitignore），不要写 `/tmp`；不要用 `&` 启动后台命令，
  不要自己起临时后台服务；tmux 只在用户安排或授权时使用。
- 实现者不担任最终验收者：完成后安排全新 agent 做独立 review，再走合并。

## 变更集与版本

- 公共包（@tom-cat/pi-browser-runtime、@tom-cat/pi-browser-use-extension）的修复/功能：
  在 `.changeset/` 手写随机 kebab-case 文件名的 md；private 包（mcp-extension）不写。
- 扩展的用户可见行为改动使用 `@tom-cat/pi-browser-runtime` changeset；扩展
  `manifest.json` 版本只由扩展 owner 在功能落地时递增。
- 不手改 CHANGELOG、不手改公共包版本；不用交互式 changeset CLI。
- 仅开发指引/文档改动通常不加 changeset，除非同时改变了公共包行为。
- fork 的 `@xmorse/playwright-core` 只有在公共 API/行为变化时才写 changeset，且必须
  先更新 playwright 的 doc/override 源再跑生成器；不要手改生成的 `types.d.ts`。
- 发布现状：没有 npm/商店发布；推送 `extension@*` tag 会自动构建并发布 GitHub
  Release，所以 tag/release 只允许在用户明确发布授权下进行；在开发/修复分支上默认
  不推送 tag、不创建 Release。

## TypeScript 与代码风格

- 静态 ESM import；不新增 require；不为了绕问题用动态 import。Node 内置模块用命名
  空间导入：`import fs from 'node:fs'`。
- 新函数多于一个参数时用单对象参数；箭头函数一律写 `{}` 块体；空数组显式声明类型；
  早返回、少嵌套；不做无意义抽象，不写无信息量注释。
- 不新增 any，不写 `(x as any).field`；先找真实类型或读 `.d.ts`。
- 改完 TS 必须跑该包的 typecheck。
- 不要手改生成的公共 Playwright 类型（`types.d.ts`）：按 doc/*.md → overrides.d.ts →
  生成器 → 重建 fork 的顺序修改。
- 新文件名用 kebab-case，不要大写字母。

## 沟通偏好

- 与用户交流用中文；阶段总结保持简短、要点式。
- 复杂架构改动前先问清楚并确认假设；发现文件里出现你没写的内容（用户或其他 agent 的
  改动）时保留并整合，绝不回退。

## 延伸阅读

- `README.md`：安装与发行现状；`pi/README.md`：Pi 包与工具说明；`pi/skills/SKILL.md`：
  模型侧用法（source of truth）。
- `docs/exec/browser-runtime-contract.md`：HTTP/WS 契约（目标态，当前实现以代码为准）；
  `docs/exec/` 下的计划与验收文档只描述具体任务（含被取代方案），不是长期指令；
  `docs/exec/extension-distribution-plan.md` 是可复用的发行清单。
- `playwriter/src/browser-protocol.ts`：类型与操作定义的唯一来源；`playwriter/src/resource.md`：
  Playwright 通用知识。
- `MEMORY.md` 是历史踩坑记录，可参考但先对照当前代码。`playwriter/src/skill.md` 仍是
  上游 legacy MCP/CLI 文档的源文件与资源生成器输入：改 legacy CLI/MCP 时要同步改它，
  模型侧现行用法以 `pi/skills/SKILL.md` 为准；`website/`、`db/`、`slop/` 及 `docs/` 下
  的非 exec 文档属于历史/上游资料。
