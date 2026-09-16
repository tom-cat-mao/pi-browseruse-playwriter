# 内容提取与 artifact 通道重设计计划

状态：进行中。协调者：主 pi 会话；执行：codebuddy swarm；验收：每波由全新 agent 独立 review 后合并。

## 目标与病根

用户需求：页面内容导出 Markdown（模型易读）、图片可选抓取（可拉可不拉）。调研发现的结构性病根：

1. `page.snapshot` 混杂"操作结构"与"阅读内容"两种职责，提取无独立操作族
2. 无一等字节通道：截图是唯一特例（PNG 写死、base64 一把梭、落盘无目录白名单）
3. 能力协商是三处硬编码白名单（pi `runtime-client.ts`、扩展 `firefox-request-validation.ts`、runtime `managed-relay.ts`），版本错位直接抛错而非降级
4. 双端（Chrome CDP / Firefox DOM）各自实现，行为漂移

## 设计支柱

1. **操作族分离**：`page.snapshot` 只管操作结构（refs/snapshotId 语义不动）；新 `page.extract` 管内容产出（format: markdown/text/html/assets-manifest），无 refs，独立预算与分页，可落盘
2. **一等 artifact 通道**：字节只走 浏览器→runtime→磁盘；模型只拿描述符 `{path, mimeType, bytes, label, sourceUrl}`；截图迁移为首个试点；`ScopedFS` 从 legacy 提拔为 managed 路径强制落盘层
3. **提取管线放 runtime（Node 侧）**：浏览器端只产出高保真 HTML；runtime 统一跑 HTML→正文提取→Markdown，一份实现、纯 Node 可测、换库不动协议。库首选 defuddle，备选 @mozilla/readability+turndown（fixture 实测决定）
4. **能力协商数据化 + 前向兼容解析**：capabilities 加 `features` 矩阵（Record<string, readonly string[]>）；三处白名单对未知项"忽略不拒绝"
5. **图片两档**：`assets-manifest`（纯 DOM 清单，零字节）→ 选中后拉字节（Chrome: CDP getResponseBody；Firefox: 扩展后台 fetch，<all_urls>+cookie 已有）；MD 可重写图片 URL 为本地 artifact 路径

## 协议基础（已落地，commit 4dcff12）

`browser-protocol.ts` 已追加：`page.extract` 操作（tabId/format/selector?/search?/offset?/limit?/path?）、`BrowserExtractFormat`、`BrowserFeatureFlags` + `capabilities.features?`、`BrowserArtifact` 可选 bytes/label/sourceUrl。Chrome worker 对 page.extract 返回 unsupported-capability stub。扩展 `firefox-request-validation.ts` FIELDS 已加 page.extract 白名单。

**所有后续任务不得再改 `browser-protocol.ts`，除非任务书明确授权。**

## 波次与任务

### Wave 1（并行，三 worktree）

| 任务 | 分支/worktree | 文件所有权 | 内容 |
|---|---|---|---|
| W1 artifact store | feat/extract-artifacts → .worktrees/ex-artifacts | playwriter/src/artifact-store.ts（新）、scoped-fs.ts、managed-relay.ts（仅 saveFirefoxScreenshot 区域 ~2419-2444 与 parseInventoryCapabilities ~1061）、相关测试 | 建 artifact store（dataDir/artifacts/ 下落盘、mime→扩展名映射含 png/jpg/jpeg/webp/gif/svg、单文件与总量上限）；saveFirefoxScreenshot 迁移走 store；managed-relay 的 parseInventoryCapabilities 透传可选 features 字段 |
| W2 MD 管线 | feat/extract-pipeline → .worktrees/ex-pipeline | playwriter/src/page-extract.ts（新）、test-fixtures、测试、playwriter/package.json + pnpm-lock.yaml | 纯 Node 模块：HTML→Markdown（defuddle 与 readability+turndown 实测对比后选一，记录理由）；输出 title/metadata/正文 MD；search 窗口化 + offset/limit 分页；不落盘（落盘由 W1 store 负责，接口预留）；fixture HTML 单测，不起浏览器 |
| W3 Pi 前向兼容 | feat/pi-forward-compat → .worktrees/pi-compat | pi/extensions/runtime-client.ts、pi/test/* | validateCapabilities：supportedOperations 含未知 op 时忽略不抛 protocol；透传并保留 features；补测试 |

### Wave 2（Wave 1 合并后）

- W4 Chrome 端 page.extract 端到端：worker page.content()→管线→响应/artifact；relay 路由 + 能力门禁
- W5 Firefox 端 page.extract 端到端：扩展产出 HTML 经通道到 runtime；能力上报
- W6 Pi 工具 browser_extract 注册 + SKILL.md + 渲染

### Wave 3

- W7 assets-manifest + 图片拉取（双端）+ MD 图片 URL 重写

### Wave 4

- W8 能力协商数据化收尾 + 文档 + changesets 检查

## 纪律（所有任务必须遵守）

- 环境：Node>=20、pnpm 10.18.1、bun；worktree 首次工作先 `pnpm bootstrap`（含 playwright 子模块构建）
- 测试只跑浏览器无关项（在对应包目录）：
  - `pnpm --filter @tom-cat/pi-browser-runtime typecheck|test:unit --run|test:integration --run`
  - `pnpm --filter mcp-extension test --run`、`pnpm --filter mcp-extension exec tsc --project .`
  - `pnpm --filter @tom-cat/pi-browser-use-extension test --run|typecheck|load-check`
  - **绝不跑默认 `pnpm test`（会启动真实 Chrome）**，不起后台服务，不动用户正在使用的 19989 runtime
- 代码风格：静态 ESM import、Node 内置用 `node:` 前缀、多参数函数用单对象参数、箭头函数写块体、不新增 any、新文件 kebab-case
- 公共包行为改动写 `.changeset/`（随机 kebab-case 文件名）；private 包（mcp-extension）不写
- 新测试不 mock；测试断言/等待超时 ≤5s
- 不 push、不建 PR、不合并——完成后报告改动清单与测试结果，由协调者验收合并
