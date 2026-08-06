# 工作流 A：pi 包本体（`pi/` 子包）

目标：新增 workspace 子包 `pi/`，即 pi package `@tom-cat/pi-browser-use-extension`。纯新增，不改任何现有文件。零 runtime dependencies（只用全局 fetch + node 内置模块；pi 相关包放 peerDependencies `"*"`）。

## 包结构

```
pi/
├── package.json          # name: @tom-cat/pi-browser-use-extension, keywords: ["pi-package"],
│                         # pi: { extensions: ["extensions"], skills: ["skills"] },
│                         # peerDependencies: @earendil-works/pi-coding-agent|pi-ai|pi-tui|typebox = "*"
│                         # license MIT, repository: tom-cat-mao/pi-browseruse-playwriter, files: ["extensions","skills","README.md"]
├── README.md             # 安装（pi install）、前置（Chrome + Playwriter 扩展）、工具列表、示例
├── extensions/
│   ├── index.ts          # 入口：注册全部工具 + /browser-status 命令
│   ├── relay-client.ts   # HTTP 客户端 + 错误分类
│   ├── bootstrap.ts      # relay 自举 + session 绑定
│   └── snippets.ts       # 各工具的 Playwright 代码片段生成器（纯函数，可单测）
├── skills/
│   └── SKILL.md          # ≤150 行蒸馏版使用纪律
└── test/                 # vitest：snippets 生成、client 错误映射、能力探测降级
```

## 核心机制

1. **relay 客户端**（relay-client.ts）：封装 `/version`、`/extension/status`、`/cli/session/new`、`/cli/execute`、`/cli/session/delete`、`/cli/capabilities`（可能 404 → 全部能力 false，降级路径）。错误分类：ECONNREFUSED（relay 未起）/ extension not connected / session 失效 / execute isError / 超时。`PLAYWRITER_TOKEN` env 存在时带 `Authorization: Bearer`（与 C 工作流对齐）。
2. **自举**（bootstrap.ts）：工具首次调用 → GET /version；失败则 `pi.exec`：优先全局 `playwriter session new`，否则 `npx -y playwriter@latest session new`（CLI 会自动拉起 relay）→ 解析 session id。此后纯 HTTP。session 与 pi 会话 1:1：命名 `pi-<sessionId前8>`，`/cli/session/new` body 带 `{name}`；id 存模块级状态；`session_shutdown` 时调 `/cli/session/delete` 清理。session 失效（execute 报 session not found）→ 自动重建一次。
3. **串行锁**：所有工具调用经 promise 链串行（浏览器状态全局，pi 默认并行执行工具）。
4. **渲染**：每个工具实现 `renderCall`/`renderResult`，折叠态=标题+一行 dim 摘要+`keyHint("app.tools.expand", …)`，展开态=全量 pretty JSON。**风格参照 `/Users/bytedance/.pi/agent/extensions/webbridge.ts`**（可直接读该文件，复用其 makeRenderCall/makeRenderResult/preview 模式）。
5. **图片内联**：execute 返回的 `images[].data`/`screenshots[].base64` 是 base64 → 直接组装 `{type:"image", data, mimeType}` 进工具 result content（`ctx.model?.input?.includes("image")` 时才内联，否则只给文本路径）。

## 工具面（9 类型化 + 1 逃生舱）

snippets.ts 中每个工具生成发给 `/cli/execute` 的代码字符串（作用域内已有 `page`/`context`/`state`/`snapshot` 等 helper；session 内 state 持久）：

| pi 工具 | 参数 | 代码要点 |
|---|---|---|
| browser_navigate | url, newTab?, group_title? | `state.page = newTab ? await context.newPage() : page; await state.page.goto(url)`；group_title 记入 session meta（经 capabilities 探测决定是否可用） |
| browser_snapshot | — | `console.log(await snapshot({ page: state.page }))` |
| browser_click | selector | 支持 `aria-ref=eN`（也兼容 `@eN` 写法映射成 `aria-ref=eN`）或 CSS：`page.locator(sel)` |
| browser_fill | selector, value | `.fill(value)`（clear-and-insert 语义，写进 description） |
| browser_evaluate | code | `page.evaluate` 或直接 eval 包 IIFE；结果 `JSON.stringify` 紧凑输出 |
| browser_screenshot | path?, fullPage? | `page.screenshot`；同时利用 execute 的 images 返回内联 |
| browser_tabs | action: list/find/close_tab/close_session, url?, active? | list→`context.pages()` 枚举 url/active；find→按 url 匹配切换 `state.page`；close_session→先探测 closeTabs 能力，无则 `Promise.all(context.pages().map(p=>p.close()))` |
| browser_network | cmd: start/stop/list, filter? | start：`state._reqs=[]; state.page.on('response', r=>state._reqs.push(...))`；list：按 filter 输出；结果存 state 跨调用读取 |
| browser_save_as_pdf | path?, format?, landscape? | `page.pdf({path, format, landscape})` |
| browser_execute | code, timeout? | 原样透传（逃生舱） |

- 每个工具写 `promptSnippet` + 必要的 `promptGuidelines`（guideline 必须显式点名工具名）。
- 错误时 throw 带分类前缀的 Error（如 `[extension-disconnected] … 请在目标标签点击 Playwriter 扩展图标`）。

## skills/SKILL.md（≤150 行）

从 `playwriter/src/skill.md` 蒸馏：aria-ref 优先（避免脆 CSS）、动作后 `getLatestLogs({page: state.page, sinceLastCall:true})` 查控制台、超时与 SPA 等待纪律（waitForLoadState/waitForResponse）、`state` 持久化模式、单引号/转义注意事项（经 pi 工具调用已无 shell 转义问题，注明即可）。

## 验收（agent 必须亲自执行并附证据）

1. `pnpm --filter @tom-cat/pi-browser-use-extension test` 绿（如未纳入 workspace filter 则直接在 pi/ 下 vitest run）。
2. jiti 模拟加载：mock ExtensionAPI 调 factory，打印注册的工具/命令清单无异常。
3. print 模式端到端（用户 Chrome 扩展已连）：
   `pi -p -e ./pi/extensions/index.ts "用 browser_navigate 打开 https://example.com（newTab），browser_evaluate 取 document.title，browser_screenshot 截图，最后 browser_tabs close_session 清理，逐步汇报"`
   → 四步全成功，截图内联可见。
4. 基线狗食任务（见 00-overview.md 验收环境节）在 print 模式跑通。
5. 降级验证：capabilities 404 时（当前 stock relay 即如此）工具仍可用。

完成后按 00-overview.md 的报告格式输出。
