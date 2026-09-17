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

### Wave 1（已合并 dev：4394a83，验收 codebuddy-7 通过）

W1 artifact store（34ea60a）、W2 MD 管线 defuddle+linkedom（bceec1b+f954b02）、W3 Pi 前向兼容（d225648）。

### Wave 2（已合并 dev：ddfb529，验收 codebuddy-13 通过，无 blocker）

W4 Chrome extract 端到端 + text 零 MD + 40K 预算（d0afdc0）、W6 Pi 工具 browser_extract（5867e5d）、W5 Firefox extract 端到端 + 强制能力门禁（2ecbf48）。

验收遗留（→ Wave 3 / 发行前清单）：
1. selector 传片段（裸 div/section）时 defuddle 判稀疏 → 静默丢正文（CONCERN；extractFromHtml 需做片段包骨架）；当前模型路径无 selector 参数，W7 修复
2. 契约文档 docs/exec/browser-runtime-contract.md 未写 page.extract（W8）
3. extension/manifest.json 0.0.139 未递增（发行前由扩展 owner 处理）
4. 可选加固：text 持久化为 .md 的 mime 语义、Chrome FakePage selector 断言、artifactTruncated 摘要措辞、非 extract op 门禁钉子测试、cdp profile 广告合并

### Wave 3（并行，四 worktree；协议 images 字段已冻结在基础提交）

| 任务 | 分支/worktree | 文件所有权 | 内容 |
|---|---|---|---|
| W7a Chrome 图片 | feat/assets-chrome → .worktrees/assets-chrome | managed-executor-worker.ts、managed-relay.ts 及测试 | assets-manifest 实现（in-page evaluate 枚举 img）；images:'urls' 返回 manifest；images:'save' Chrome 拉字节（in-page fetch 带 cookie/CORS → 兜底 worker fetch）→ artifact store → MD URL 重写；relay 层 images 门禁（features.assets 含 'save'/'urls'，Chrome 由 relay 合成） |
| W7b Firefox 图片 | feat/assets-firefox → .worktrees/assets-firefox | firefox-executor-worker.ts、firefox-executor-protocol.ts（runtime 侧）、extension/src/*（background fetch 二进制通道、features 广告）、扩展测试 | assets-manifest（DOM evaluate 枚举）；images:'save' 走扩展后台 fetch（<all_urls>+cookie 无 CORS）base64 回传 → relay 落盘；features: {assets:['urls','save']} 广告；旧扩展无广告即门禁拒绝 |
| W7c Pi 图片参数 | feat/assets-pi → .worktrees/assets-pi | pi/ 全部 | browser_extract 暴露 format 'assets-manifest' 与 images 参数；门禁到 features 级；renderResult 资产清单/落盘呈现；SKILL.md |
| W7d 片段骨架修复 | feat/extract-fragment-fix → .worktrees/ex-fragment | page-extract.ts 及测试 | extractFromHtml 入口：输入无 <html/<body 视为片段→包最小文档骨架；近空结果且明显低于可见文本估算时显式失败；fixture 测试 |

### Wave 4

- W8 能力协商收尾 + 契约文档 + changesets 检查 + 发行前清单（manifest 版本）

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
