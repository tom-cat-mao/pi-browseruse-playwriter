# Firefox 普通扩展使用与能力边界

当前为开发预览：生产代码审查、浏览器无关测试及打包已通过；真实 Firefox 验收按用户本轮决定保留待办。状态见[交付与验收记录](firefox-extension-acceptance.md)。

本分支提供普通 Firefox WebExtension 后端，使用现有 Pi 包和本地 managed runtime。
它接管已经打开的真实标签和登录态，不要求 Remote Agent、BiDi、Marionette 或调试启动参数。
开发目标为桌面 Firefox 139+；其它 Firefox 衍生浏览器需分别验证。

状态：本地开发构建，未申请 AMO 签名、未上架，也没有 npm 发布。真实浏览器验收仍需单独完成；
能够构建、类型检查通过和浏览器中的实际兼容性是不同的验收项。

## 构建和临时加载

第一次从新 checkout 开始，先准备 Node.js 20+、pnpm 10.18.1 和 Bun：

```bash
pnpm bootstrap
pnpm --filter @tom-cat/pi-browser-runtime build
```

runtime 构建会分别生成 Chrome 与 Firefox 的扩展 bundle。以后只改 Firefox 扩展时可以运行：

```bash
pnpm build:firefox
pnpm package:firefox
```

| 路径 | 内容 |
| --- | --- |
| `extension/dist-firefox/` | Firefox 扩展，可选择其中的 `manifest.json` 临时加载 |
| `playwriter/dist/extension-firefox/` | runtime 包内的 Firefox bundle，供打包命令使用 |
| `dist-release/pi-browser-use-firefox-extension-<version>.zip` | 本地 ZIP，可解压检查或用于签名准备 |
| `dist-release/pi-browser-use-firefox-extension-<version>-unsigned.xpi` | 明确未签名的 XPI 开发产物 |
| 每个归档旁的 `.sha256` | 对应归档的 SHA256 校验文件 |

构建和打包只写本地文件，不加载扩展、不启动浏览器、不更改 Pi 安装或运行中的 runtime。
Chrome 仍单独输出到 `extension/dist` / `playwriter/dist/extension`，其开发身份不变。
Firefox Gecko 身份是 `pi-browser-use@tom-cat-mao.github.io`，不是 Chrome 商店 ID。

在 Firefox 中打开 `about:debugging#/runtime/this-firefox`，选择 **加载临时附加组件**，
再选 `extension/dist-firefox/manifest.json`。临时扩展会在 Firefox 重启后卸载。
标准 Firefox 的永久安装需要 Mozilla 签名；不能把这个未签名 XPI 当作已经发布的安装包。
本项目不要求关闭签名检查或更改浏览器偏好。

默认连接 `127.0.0.1:19989`。需要连接另一套本地开发 runtime 时，在构建命令中设置
`PI_BROWSER_HOST`（仅 loopback）和 `PI_BROWSER_PORT`；runtime 必须使用相同配置。
只构建扩展时也可以用 `pnpm --filter mcp-extension build:firefox`。
`PI_BROWSER_FIREFOX_DIST` 仅接受 `dist-firefox` 或 `dist-firefox-<suffix>`，避免覆盖 Chrome 产物。
构建只读取公开 host/port，不把 `PI_BROWSER_TOKEN` 编入扩展。

## 接管现有标签

1. 在 Pi 中调用 `browser_profiles`，确认 Firefox profile 为 `connected`，读取其能力信息。
2. 用 `browser_tabs` 的 `discover` 查看真实已开标签的元数据。根据用户描述选择候选，不能凭列表顺序猜测。
3. 用 `attach` 和返回的 `candidateId` 原地接管。扩展不刷新标签，不搬窗口，也不连带接管同组的其它页面。
4. 后续工具显式使用返回的逻辑 `tabId`。先 snapshot，再操作，然后观察结果。
5. 完成后用 `release` 放手并保留页面，或明确用 `close` 关闭。扩展弹出页的“释放当前标签”也可由用户主动放手。

profile、group、tab、snapshot 都使用既有资源模型。Firefox 的原生标签编号只用于后端映射，
不能代替 Pi 返回的逻辑 `tabId`。不同 session 的资源隔离、release tombstone 和重连校验继续生效。

## 页面 JavaScript 是可选能力

标签管理、快照、点击、填写等基本 DOM 工具通过静态打包脚本实现，不需要 `userScripts` 权限。
动态 `browser_evaluate` 及 execute 中的 evaluate 方法使用 Firefox 的独立 `USER_SCRIPT` 世界，
需要 **Firefox 153+** 的 `userScripts.execute` 和用户授予的可选 `userScripts` 权限。

启用方法：点开扩展弹出页，点击 **启用页面 JavaScript**，在 Firefox 的正常权限请求中确认。
这是扩展自身的可选功能，不是开启远程调试。未启用或 Firefox 版本过低时，evaluate 返回具体的
`unsupported-capability`；其他可用工具继续工作。权限变化后重新调用 `browser_profiles` 查看实际能力。

evaluate 世界可读取和修改页面 DOM，但不等价于 Chrome 主世界：页面自己定义的全局变量、框架内部对象
不一定可见，也不能调用扩展的 `browser.*` API。代码需要显式 `return` 返回 JSON 可序列化结果。
扩展不会通过 MAIN-world 注入、打开用户脚本消息通道、放宽 CSP 或 `unsafe-eval` 绕过这一边界。

## 与 Chrome 的差异

| 能力 | Firefox 行为与边界 |
| --- | --- |
| profiles / groups / tabs | 保留具名 group、显式 tab、原地 attach、来源 tab 和 release 语义；扩展维护归属事实 |
| navigate / back / activate | 操作指定标签和真实浏览器历史；网站决定返回后的表单、滚动恢复 |
| snapshot | 从 DOM 与 ARIA 语义生成快照与短 ref；不是 Chrome 原生 AX 树，隐藏节点和名称可能存在差异 |
| click / fill | 严格 selector/ref 与可操作性检查；通过 DOM 点击、赋值、输入事件完成，无法产生可信的原生输入 |
| evaluate | Firefox 153+ 和可选权限；独立用户脚本世界、显式 return、JSON 结果；完成后旧 ref 保守失效 |
| screenshot | 捕获显式 tab，可请求全页与标签；受 Firefox 页面尺寸、可访问内容和截图 API 限制 |
| network | 仅采集已绑定受控 tab 的事件；响应正文有容量、类型和 API 限制，不表示完整网络回放 |
| logs | 已接管后可采集的 console/error/rejection；接管前日志不回填，缺少日志不能证明页面没有错误 |
| execute | Node 隔离 worker 提供 page/locator 的 DOM 兼容接口；不是完整的 Chromium Playwright/CDP 对象模型 |

Firefox 的输入事件来自 DOM API。通常的链接、表单和内容编辑可以使用这一路径，但依赖
`Event.isTrusted`、真实键盘/指针、系统选择器或浏览器内置交互的页面可能拒绝动作。
工具不会通过伪造信任、扩大权限或切换到另一个浏览器掩盖失败；应观察结果后决定下一步。

普通扩展无法控制浏览器保护的页面，例如 `about:`、扩展管理页和 Firefox 禁止脚本注入的站点。
网站权限、跨源 frame 和页面 CSP 限制也可能影响具体内容。拒绝访问时按错误给出的页面和操作处理，
不要认为所有 Gecko 浏览器、所有站点都已通过兼容性验证。

DOM locator 可遍历同源 iframe 与 open shadow DOM；跨源 iframe 由扩展按实际 frame 身份定向执行，
仍要求相应的网站权限。closed shadow DOM 不可读取。`hover` 只派发 DOM 事件，不改变浏览器原生
CSS `:hover` 状态；浏览器快捷键、系统剪贴板快捷键等会明确拒绝。console bridge 无法建立时，
日志结果说明采集不完整。对 ref 使用 evaluate 时无法跨执行世界传递元素句柄，应改用 CSS/role locator。

snapshot 的 ref 绑定具体文档和元素；导航、元素变化或任何 evaluate/execute 之后，需要重新 snapshot。
CSS/role selector 零个或多个匹配都报错，不使用 `.first()` 猜测。超时或取消不重放；已经开始的动作可能
返回 `outcome: unknown`，此时先观察当前状态。

## execute 使用范围

优先使用结构化工具。需要多步逻辑时，`browser_execute` 仍按显式 `tabId` 提供 `page`，
常用 locator 创建、读取和 DOM 操作由 Firefox 后端执行。等待、返回值、console 和纯数据 `state`
在本地隔离 worker 中处理，页面动作仍逐次验证当前归属。

| 接口类别 | DOM 兼容接口 |
| --- | --- |
| 查找 | `locator`、`getByRole`、`getByText`、`getByLabel`、`getByPlaceholder`、`getByTestId`、`getByAltText`、`getByTitle` |
| 组合 | 链式 locator、`filter` 的 `has` / `hasNot` / `hasText` / `hasNotText`、显式 `nth` / `first` / `last` / `all`、`frameLocator` |
| 动作 | `click` / `dblclick`、`fill` / `clear` / `type` / `pressSequentially` / `press`、`check` / `uncheck` / `setChecked` / `selectOption`、`hover` / `focus` / `blur` / `scrollIntoViewIfNeeded` |
| 焦点输入 | `page.keyboard.press` / `page.keyboard.type`，仅对当前受控 tab 中匹配 `:focus` 的元素执行 DOM 操作 |
| 读取 | `count`、文本/HTML/输入值/属性、可见/启用/勾选状态、`boundingBox`、`waitFor` |
| page | `goto` / `goBack`、`title` / `url` / `content`、`evaluate`、`screenshot` 及常用 locator 动作的 page 简写 |
| 等待 | `waitForURL` / `waitForLoadState` / `waitForFunction` / `waitForSelector`，以及 `setDefaultTimeout` |
| 辅助 | `snapshot`、`refToLocator`、`getLatestLogs`、`screenshotWithAccessibilityLabels`、`waitForPageLoad`、纯数据 `state`、console 和返回值 |

普通 selector 仍严格匹配；`first` / `nth` 仅在代码显式调用时选择位置，不能作为模糊匹配的自动回退。
文本匹配参数目前用字符串，不支持正则。`goto` / `goBack` 返回 `null`，不返回 Playwright 的
Response 对象。`page.url()` 是最近受控页面响应观察到的同步 URL；需要最新导航结果时先执行并等待页面操作。
`getLatestLogs` 需要 await。`state` 属于 session/profile/浏览器代际，worker 被取消、重启或释放后不能假定仍在。

Firefox 的 `page.keyboard.press/type` 是对当前 tab 中 `:focus` 元素的 DOM helper，遵守严格匹配，
不会向系统或其它标签派发原生键盘输入。Chrome execute 仍不公开 `keyboard` 对象；两端都不支持
`mouse` / `touchscreen`，Firefox 也不支持 `keyboard.down/up` 等其余键盘方法。

等待的默认 timeout 为 5000 ms，显式 timeout 和 `setDefaultTimeout` 接受 1–5000 ms，
同时受整个 execute 剩余时限约束。`waitForURL` 接受 URL 字符串以及 `*` / `**` 通配符，不接受正则；
`waitForLoadState` 可等待 `load` / `domcontentloaded`，`commit` 不附加等待，`networkidle` 不支持。
`waitForURL` 的可选 `waitUntil` 会在 URL 匹配后增加对应的加载状态等待，两阶段分别受等待上限约束。
`waitForSelector` 保持严格匹配，返回 locator；等待 `hidden` / `detached` 时返回 `null`，不是 ElementHandle。
`waitForFunction` 通过 evaluate 轮询，需要 Firefox 153+ 和可选页面 JavaScript 权限，返回首个为真的
JSON 可序列化普通值，不返回 JSHandle。

在 execute 中使用 snapshot ref 也必须绑定 `snapshotId`：可通过 `page.locator(ref, { snapshotId })`
显式传入，或在当前调用获取 `snapshot` 后使用 `refToLocator({ page, ref })` 生成带 snapshot 绑定的
selector。查不到 ref 时 helper 返回 `null`；不要去掉返回 selector 的 snapshot 后缀，也不要把裸 ref
自动解释为最新快照。导航、元素变化或 evaluate 后仍需重新观察。

CDP session、浏览器/上下文创建或关闭等不支持的接口明确报错。返回普通数据，不跨调用保存
page/locator 句柄。await 每一个动作，不留下后台任务；需要动态页面 evaluate 时满足上面的可选权限要求。

## 验证与维护

浏览器无关检查包括 runtime 与 Pi 的 typecheck、真实 HTTP/WS/隔离进程逻辑测试、DOM fixture、
Chrome 与 Firefox 构建及归档解压/校验。它们不替代在真实 Firefox 中验证受控输入、页面权限、
跨源 frame、截图、网络正文、重连和可选权限弹窗。

真实浏览器验收要由用户准备并加载扩展后再进行；只创建验收自己的 fixture 和标签。
尚未运行的浏览器场景应记录为 SKIP，不能标记 PASS。执行计划与最终验收记录分别维护，
本指南不把仍待验收的目标写成对所有网站的保证。

官方 API 依据：

- [Firefox 与 Chrome 的 WebExtension API 差异](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities)
- [scripting.executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)
- [userScripts.execute 及兼容性](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts/execute)
- [webRequest.filterResponseData](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData)
- [临时安装扩展](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)
- [签名与分发](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
