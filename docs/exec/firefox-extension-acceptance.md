# 普通 Firefox 扩展交付与验收记录

日期：2026-09-12。交付分支：`codex/firefox-extension`；PR base：`dev`。

当前状态：**实现、全套浏览器无关检查、独立生产代码审查和打包验证已完成；真实浏览器验收待用户准备。** PR 在真实 Firefox 验收完成前保持 Draft。本记录不是 Firefox 全功能已通过浏览器实测的声明。

## 实际交付

- 普通 Firefox MV3 扩展，通过现有本地 runtime 操作真实已开标签，无 Remote Agent/BiDi/Marionette 或浏览器启动参数。
- profiles/groups/tabs、原地 discover/attach/release、具名组、sourceTabId、真实历史返回与激活；扩展保留归属事实来源，epoch/revision/tombstone 与多 session 校验。
- DOM/ARIA snapshot、显式 snapshotId/ref、strict CSS/role/locator、常用表单与 DOM 输入、截图、网络采集、日志。
- Firefox 153+ 的可选 USER_SCRIPT evaluate；基本 DOM 操作不依赖该权限，较旧版本或未授权时返回具体能力提示。
- 独立进程中的常用 page/locator execute 接口，状态、console、JSON、Buffer 与常用 URL/文本处理；暴露对象在自己的 JS context 内构造，通过有界 JSON 消息调用页面。
- 跨源 iframe 使用 Firefox 的真实 frame ID、逐级父页面操作点与遮挡检查、短期且单次消费的准备记录；不按 URL、标题或窗口顺序猜归属。
- Chrome 原有 CDP 后端及安装身份保留；协议只追加可选字段，新 Firefox 不伪造 CDP 身份。
- Pi 将浏览器能力与限制放进模型 content；Firefox 的独立构建、ZIP/XPI 与 SHA256，以及用户指南。

用户指南：[firefox-extension-guide.md](firefox-extension-guide.md)。总执行文档：[firefox-extension-execution-plan.md](firefox-extension-execution-plan.md)。早期研究记录：[firefox-rust-feasibility.md](firefox-rust-feasibility.md)。

## 自动检查

所有有端口/进程的套件由协调者串行安排。没有运行默认会启动 Chrome 并更新快照的 `pnpm test`。

| 检查 | 实际结果 |
| --- | --- |
| runtime TypeScript | PASS |
| runtime unit | PASS，293 tests / 22 files |
| runtime integration | PASS，34 tests / 4 files |
| Firefox/Chrome 扩展纯逻辑和 JSDOM | PASS，85 tests / 6 files |
| 扩展 TypeScript | PASS |
| Pi 真实 HTTP 与工具结果测试 | PASS，97 tests / 3 files |
| Pi TypeScript / load-check | PASS；12 tools、browser-status、session_shutdown |
| `pnpm build` | PASS；Chrome 与 Firefox 独立 bundle |
| runtime distribution smoke | PASS |
| Chrome ZIP + 解压/身份/SHA256 | PASS |
| Firefox ZIP / unsigned XPI + 解压/SHA256 | PASS |
| 默认与测试构建分离 | PASS；正式产物保留默认 runtime 地址，验收使用独立构建 |

四套测试合计 509 项。最终 URL 行为修复后重新运行了 runtime 全 unit 与 Pi 检查，并重新构建、打包。日志保存在本地 `tmp/final-checks/`；它们不是版本化源码的一部分。

## 独立审查及修复

实现分为 runtime、资源、DOM、execute、Pi/发行五个独立 worktree，由未参与实现的 Agent 进行审查。发现问题交回 owner 或协调者修复后复验，不由实现者独自宣布通过。

| 发现 | 已落修复与验证 |
| --- | --- |
| execute 向脚本暴露了来自宿主环境的对象 | 静态 bundle 在独立 JS context 中创建 facade/state/console/Promise/bytes；隐藏消息桥只传有界 JSON，禁止动态代码生成；真实 worker 对象归属与功能回归 PASS |
| 未 await 的页面拒绝可导致 worker 退出并丢 state | 收集异步拒绝为结构化失败，清理后保留 worker state；已捕获异常仍能正常继续；真实子进程回归 PASS |
| MV3 后台延迟注册事件监听器 | constructor 同步注册，事件等待初始化；alarms 提供休眠后的连接唤醒；源码复核与扩展检查 PASS |
| 截图取消导致 labels 无法清理 | 新内部 cleanup 请求与独立清理预算；真实 JSDOM 原始复现已恢复清理 |
| 跨源 iframe 缺失父层遮挡检查 | 真实操作点、content quad 映射、frame 身份及逐级 hit-test；准备 token 固定元素和点；纯逻辑/坐标测试 PASS，浏览器几何仍待实测 |
| Enter 在表单按钮上误触发提交 | 按钮自身激活优先，文本输入按默认 submitter 做隐式提交；原始复现已变为 click=1、submit=0 |
| iframe URL 污染顶层 pageInfo | 每次操作后重新核验顶层 tabs.get 事实，子页面 URL 不冒充逻辑 tab URL |
| URL.searchParams 对象与查询参数不保持同步 | 缓存同一对象、双向读取/更新、迭代期间新增参数；新增真实 worker 测试独立 PASS |

独立验收还读取了实际打包产物，验证 manifest、22 个归档文件与 bundle、CRC、SHA256、普通 MV3 权限、Gecko ID，以及 Chrome ID。独立报告保存在本地 `tmp/firefox-dom-independent-review.md`；前一份 runtime 审查记录在 `tmp/runtime-independent-review.md`。两次子 Agent 曾被自动内容审查中断，协调者保留其代码/报告并完成正常生产代码修复，再交给独立验收者复核。

## 尚未完成的真实浏览器阶段

以下项目目前为 **NOT RUN**，不能由 JSDOM、协议 peer、源码或打包成功代替：

- Firefox 临时加载、扩展权限弹窗、实际 WS Origin/握手与连接。
- 真实已开页面的表单和滚动保持，原地 attach/release，新标签来源与真实历史。
- 受控表单、contenteditable、动态 DOM、跨源 iframe、真实几何、遮挡和截图。
- USER_SCRIPT 返回值与隔离、实际页面 console、webRequest response filter。
- 取消/重连及 Firefox MV3 事件页休眠、alarms 唤醒。
- 必要的 Chrome 浏览器回归（原有无浏览器回归已通过）。

已准备本地 fixture：`extension/test-fixtures/firefox-acceptance.html`。测试阶段只操作本次创建的 fixture 和标签，使用独立本地 runtime 与数据目录；不替换用户正在运行的 runtime，不关闭用户浏览器。加载扩展与开始浏览器阶段先按 AGENTS.md 获取用户准备确认。

## 明确的能力边界

- DOM 输入不能产生浏览器原生 trusted 事件，也不保证 native hover、IME、操作系统快捷键、文件选择器等行为。父 frame 校验与子 DOM dispatch 存在跨进程时序间隔，不能宣称原生输入等价。
- snapshot 来自 DOM/ARIA 算法，不能等同 Chrome 原生 AX 树；closed shadow root 不可读；无法准确映射的 iframe 变换明确拒绝。
- evaluate 需要 Firefox 153+ 的用户脚本权限，运行在 USER_SCRIPT 世界；不提供扩展 storage/runtime API，也不声称能访问所有页面 MAIN 全局变量。
- execute 提供文档列出的常用接口，并非完整 Playwright/CDP。方法、选项或能力缺失明确报错；跨调用 page/locator 句柄不可沿用。
- Firefox 网络缓存主要在扩展侧维护，断线时 runtime 没有完整镜像；断线期间的列表行为与 Chrome runtime 采集有差异。这是当前实现边界，而非声称平台永远做不到。
- 现有 Firefox/ESR/Zen/LibreWolf 发行版未逐一实测，不能仅因同属 Gecko 就宣称全支持。
- 当前 Firefox 产物未签名，正常长期安装需要签名；未发布 npm、AMO、Chrome Web Store、tag 或 GitHub Release。

Rust 未在本批次引入。Pi 与执行环境继续保留 JS/TS，后续可依据实际性能基线独立迁移本地 runtime 或计算热点。
