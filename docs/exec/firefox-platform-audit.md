# Firefox DOM 平台兼容同类缺陷审计

0.0.136 之后。分支 `fix/firefox-platform-audit`，基线 `f963175`（含 0.0.133 CSP、
0.0.134 后台保活、0.0.135 create 预热、0.0.136 `Window.getComputedStyle` 绑定）。
本文只覆盖 `extension/src/firefox-dom*.ts`（DOM driver、locators、input、frame）。
`firefox-background.ts`、`firefox-resources.ts`、`firefox-api.ts`、`firefox-network.ts`、
runtime、协议、manifest/版本与构建脚本不属本 owner；仅只读核对，结论见“跨边界”。

用户已在真实 Firefox 155.0.1 验证 0.0.136 的建组、创建标签（返回 tabId）、snapshot、
screenshot、`execute page.title()`、release 成功。本轮据此系统核对同类风险，
区分**已确认 bug**、**需实机验证**与**平台已声明限制**，不无依据改动、不放宽校验、
不删除检查、不改 Chrome 专用实现。

## 逐类结论

| 审计类别 | 结论 | 关键证据 |
| --- | --- | --- |
| DOM/WebIDL 方法提取丢 `this` | 仅 0.0.136 的 `getComputedStyle` 一处，已修；本文件已无其它裸提取 | 全文件扫描无未被调用的 DOM 方法引用；3 处 `getComputedStyle` 均为方法调用或已绑定 helper |
| 第三方库默认回调 | 已闭合 | `dom-accessibility-api@0.7.1` 只有 `isInaccessible` 存在默认解构（`is-inaccessible.mjs:17/48`）；`computeAccessibleName` 默认 `safeWindow(root).getComputedStyle.bind(window)`（`accessible-name-and-description.mjs:226/232`，`util.mjs:25-32`）；`getRole` 不用 computed style |
| 跨 iframe/Window realm 构造器 | 干净 | driver 内 DOM 构造器全部为 `view.X`/元素自身 `defaultView`；`XMLSerializer`、`MutationObserver`、`PointerEvent`、`MouseEvent`、`KeyboardEvent`、`InputEvent`、`Event` 均按元素所在文档取 realm |
| 跨 realm `instanceof`/原型/setter | 干净（1 处低风险见 P2-2） | 无 `instanceof HTML*`；元素判定用 `localName`；`setNativeValue` 用 `element.ownerDocument.defaultView.HTMLInputElement.prototype` 的原生 setter 并 `.call(element)` |
| Shadow DOM | 干净 | `composedParent` 走 `assignedSlot`/`parentElement`/ShadowRoot.host；`allElements`、snapshot 递归 shadowRoot，slot 用 `assignedNodes({flatten:true})` |
| 可见性/ARIA 语义 | 干净（1 处待验见 P2-3） | `isVisible` 逐 composed 祖先查 display/visibility + 包围盒；`ariaVisible` 逐 composed 祖先 `isInaccessible`（own-document view）+ `inert`；role options（checked/disabled/expanded/selected/pressed/level/includeHidden）与协议一致 |
| input 语义 | 代码层干净，未实机（P2-1） | Enter/Space/Tab/方向键分支；`input[type=number]` 等 `selectionStart` 返回 null 时提前给出 `unsupported-capability`，不调用会抛 `InvalidStateError` 的 `setSelectionRange` |

## P0

无新增。0.0.136 已修的真实 Firefox 阻断（snapshot/role locator 的 `getComputedStyle`
Window 接收者错误）不回退。

## P1（已确认，已修）

### P1-1 纯 HTTP 页面进不了 DOM driver：`crypto.randomUUID` 只在安全上下文暴露

**现象（推断的确定性失败路径）**：在受支持的 `http:` 页面上，注入 `firefox-dom.js`
时 driver 顶层构造抛错，`globalThis.__piFirefoxDom` 保持 undefined；随后 `attach`
的能力探针注入与所有 DOM 工具（snapshot/click/fill/…）都对该标签失败。用户实机只测过
`https://example.com`，因此未暴露。

**根因（代码 + 规范证据）**：

- `createFirefoxDomDriver` 在建 driver 时直接 `view.crypto.randomUUID()`
  （原 `extension/src/firefox-dom.ts:196`，snapshot id `:476`、prepared action id `:744`）。
  `view = document.defaultView`，即**页面自身窗口**。
- WebCrypto 规范中 `Crypto.randomUUID()` 标注 `[SecureContext]`，
  `getRandomValues()` 没有（<https://w3c.github.io/webcrypto/> 第 10 节）。MDN 亦标注
  randomUUID 仅安全上下文可用。非安全上下文里该成员**不存在**（不是抛错），所以
  `view.crypto.randomUUID()` 抛 `... is not a function`。
- 页面选择并未排除 http：`firefoxPageSupported` 接受 `http:` 与 `https:`
  （`extension/src/firefox-resources.ts:80`），`inject()` 对任意支持页面注入
  `firefox-dom.js`（`extension/src/firefox-background.ts:1314-1318`）。
- 该文件顶层无条件构造 driver（`firefox-dom.ts:1081-1082`），因此失败发生在注入期，
  而非某个具体命令。
- 与 0.0.136 同类：都是“Firefox 平台 API 暴露/接收者语义与 Chrome 假设不一致，
  让本应可用的代码整体失败”。

**修复（最小、根因）**：`firefox-dom.ts` 内新增局部 `randomId()`，用
`view.crypto.getRandomValues(new Uint8Array(16))` 生成 16 字节并置 v4 版本/变体位，
格式化为 UUID；三处 `randomUUID()` 全部改为 `randomId()`。`getRandomValues` 不受安全
上下文限制，且在安全上下文下同样工作，因此单一代码路径不会留下未测分支。ID 仍是随机
v4 UUID，外部形状 `firefox:<document>:<snapshot>` 不变。

未扩大权限、未改 CSP/协议/ownership/取消语义、未删除任何检查、未新增注释或 mock。
未改 manifest 版本（按分工由协调者递增）。

**回归**：`extension/tests/firefox-dom.test.ts` 新增
`derives document and snapshot identities from page crypto without the secure-context-only randomUUID`：
断言 snapshotId 匹配 `firefox:<v4>:<v4>`、两次 snapshot 的 document 段稳定而 snapshot
段不同。该用例走的就是 http 页面会走的同一条 `getRandomValues` 路径（无分支），
因此该路径被完全覆盖。

**未覆盖的边界**：JSDOM 的 `crypto` 与 driver 同 realm，不能复现 Firefox 内容脚本里
“页面 realm 的 ArrayBufferView 传入页面 Crypto”的 Xray 细节；也未用伪造/删除浏览器
API 的方式模拟非安全上下文（按约束不新增 mock/伪造 API）。需实机在真实 http 页面复验
（见下）。

## P2（未修：需实机验证或低频/边界）

- **P2-1 输入类命令未在真实 Firefox 实测（需实机）**。`fill` 依赖页面原型原生 value
  setter（`firefox-dom-input.ts:153-160`），`click/dblclick/hover/type/press/check/
  selectOption` 依赖页面 realm 的合成鼠标/指针/键盘/输入事件。realm 与原型均取自元素
  自身文档，代码层正确，但用户只验过 snapshot/screenshot/title。需实机验证
  `fill`/`type`/`press`/`check`/`selectOption`/`hover` 与遮挡命中检查。
- **P2-2 `error instanceof Error` 的跨 realm 兜底（低风险）**。
  `firefox-dom.ts` 错误映射用 `error instanceof Error`/`instanceof FirefoxDomError`。
  0.0.136 实机证明 Firefox 绑定层抛出的 TypeError 在此为真，故当前不构成 bug；
  仅当错误来自另一个 compartment 的 evaluator 且未跨世界包装时才会退化为
  `String(error)`。未改。
- **P2-3 仅按 display/visibility 判定隐藏，未覆盖 `content-visibility`（需实机，低置信）**。
  `ariaVisible` 依赖 `isInaccessible` 的 `display:none`/`visibility:hidden`/
  `aria-hidden`/`hidden` 与 `inert`。若某浏览器用 `content-visibility: hidden`（而非
  `display:none`）隐藏子树（例如折叠的 `<details>` 内容），snapshot 可能包含不可见节点。
  属“隐藏节点可能存在差异”的声明范围，未证实 Firefox 当前如此，未改。实机应检查
  折叠 `<details>` 内内容是否进入 snapshot。
- **P2-4 `frame.check`/frame 内动作依赖 `getBoxQuads`（平台边界，非缺陷）**。
  已核对 Firefox `GeometryUtils.webidl`：`getBoxQuads` 为 `[Throws,
  Func="nsINode::HasBoxQuadsSupport", NeedsCallerType]`，**非** `ChromeOnly`、**非**
  Pref 门控，内容脚本可见；代码在缺失或非轴对齐时给出明确 `unsupported-capability`。
  iframe 内输入仍需实机验证。

## 平台已声明限制（非缺陷，不回退）

- 不产生可信原生输入：DOM 合成事件的 `isTrusted=false`；`hover` 不改原生 `:hover`；
  浏览器快捷键与系统剪贴板明确拒绝（`firefox-dom-input.ts:308-317`）。
- closed shadow DOM 不可读；跨源 iframe 走扩展 frame 身份；`about:`/特权页/受限域不可控。
- snapshot 是 DOM/ARIA 而非 Chrome 原生 AX 树，隐藏节点与名称可能有差异。
- evaluate 需 Firefox 153+ 与可选 userScripts 权限；ref 不可跨执行世界。

## 跨边界（只读核对，无改动）

- `firefox-resources.ts:60` 的 `firefoxId()` 用**扩展 realm** 的 `crypto.randomUUID`；
  扩展页是 `moz-extension:` 安全上下文，不存在 P1-1 问题。
- 其它 `firefox-*.ts` 未见 WebIDL 方法裸提取、realm 错用构造器或跨 realm `instanceof`
  元素判定；`firefox-popup.ts:10-11` 的 `instanceof HTMLButtonElement` 作用于同文档元素，
  安全。
- manifest 版本与 changeset 版本递增按分工由协调者处理。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| 扩展 TypeScript（`mcp-extension exec tsc --project .`） | PASS |
| 扩展测试（`mcp-extension test --run`） | PASS，101 tests / 6 files（新增 1） |

未运行默认会启动 Chrome 的 `pnpm test`，未运行 runtime 端口/进程套件，未启动浏览器或
后台服务，未加载/重载扩展，未改用户配置。日志：`tmp/logs/tsc-fix.log`、`tmp/logs/test-fix.log`。

## 需实机复验场景

1. **P1-1（最高优先）**：加载含本修复的构建，attach 一个非 loopback 的纯 `http:`
   页面，确认 profile/tab 连接与 snapshot 成功；修复前该场景应整体失败。
2. `fill`/`type`/`press`/`check`/`selectOption`/`hover` 在真实页面（普通表单、
   contenteditable、`input[type=number]`）的实际效果与事件语义。
3. 折叠 `<details>` 与 `content-visibility: hidden` 内容是否被 snapshot 排除（P2-3）。
4. iframe 内 role/ref 定位、`frameLocator` 与 frame 内点击（`getBoxQuads` 路径）。
5. 真实页面隐藏/aria-hidden/inert 子树过滤（0.0.136 仅覆盖 JSDOM 语义）。
