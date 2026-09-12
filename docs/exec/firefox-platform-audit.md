# Firefox DOM 平台兼容同类缺陷审计

0.0.136 之后。分支 `fix/firefox-platform-audit`，基线 `f963175`（含 0.0.133 CSP、
0.0.134 后台保活、0.0.135 create 预热、0.0.136 `Window.getComputedStyle` 绑定）。
本文只覆盖 `extension/src/firefox-dom*.ts`（DOM driver、locators、input、frame）。
`firefox-background.ts`、`firefox-resources.ts`、`firefox-api.ts`、`firefox-network.ts`、
runtime、协议、manifest/版本与构建脚本不属本 owner；仅只读核对，结论见“跨边界”。

**定级口径**（本文严格区分，避免把未实测当缺陷）：

- **已实测缺陷**：真实 Firefox 上复现或已修复并有实机证据。
- **基线对照失败 + 高置信根因**：在真实不可信 origin 上已观测到相关失败，根因有实现级
  证据；未取得精确内容脚本堆栈，修复实机待验。
- **代码风险**：有代码/实现级证据，但未在真实环境复现；需实机基线确认或否定。
- **待实机验证**：功能尚未在真实浏览器跑过，本身不是缺陷，只是覆盖缺口。
- **平台已声明限制**：已知且文档化的边界，不作为缺陷。

## 结论摘要

- 已实测：0.0.136 基线场景（建组、创建标签、snapshot、screenshot、`page.title`
  execute、release）在真实 Firefox 155.0.1 PASS（用户）。
- 基线对照失败 + 高置信根因：1 条（`crypto.randomUUID` 的安全上下文暴露）。独立基线
  已在**不可信 origin**（`http://localtest.me:<loopback fixture port>`）拿到失败对照：
  页面自身 `isSecureContext=false`、`crypto.randomUUID=undefined`，且该页面的
  snapshot/locator 进 driver 失败（`content script returned invalid result`）；同
  fixture 在 `127.0.0.1`（潜在可信 origin）正常。根因有 Gecko 实现级证据，但**未取得
  精确内容脚本堆栈**。修复**实机待验**（并入集成后用新版闭环）。
- 未发现其它已确认问题。
- 未修的其余项仅为低频代码风险，或属待实机验证的覆盖缺口，或平台已声明限制。

## P0

无。

## P1——基线对照失败 + 高置信根因（修复实机待验）

### `crypto.randomUUID` 的 `[SecureContext]` 暴露依赖调用者/对象 realm

**风险描述**：`createFirefoxDomDriver` 用页面窗口的 `view.crypto.randomUUID()` 生成
document/snapshot/prepared-action id（修复前 `firefox-dom.ts:196/476/744`）。若在普通
`http:` 页面上该成员不可见，driver 顶层构造会抛错，`globalThis.__piFirefoxDom` 为空，
attach 探针与所有 DOM 工具对该标签失败。

**独立基线对照（owner 13，只读观测）**：

- 对照页：`http://localtest.me:<本机 loopback fixture port>`（`localtest.me` 解析到
  loopback，但 origin 不是潜在可信 origin，因此不是安全上下文）。
- 页内独立读数：`isSecureContext=false`、`crypto.randomUUID=undefined`。
- 该页 `snapshot`/`locator` 进 driver 失败，报 `content script returned invalid result`。
- 对照组：同一 fixture 在 `127.0.0.1` 可用（`127.0.0.1` 是潜在可信 origin）。
- 结论口径：这是**实际不可信 origin 的失败对照 + 高置信根因**，不是“仅规范推断”。
  未取得内容脚本精确堆栈（也不声称有）。


**为什么不能只靠规范断言“http 一定失败”**：WebCrypto 规范只说明 `randomUUID()` 标注
`[SecureContext]`（`getRandomValues()` 没有），它只直接证明**普通页面 realm** 的暴露规则，
不能推出 Firefox 内容脚本/Xray 是按“调用者”还是“页面窗口”决定暴露。这一点必须查 Gecko
实现，下面是核查结果。

**Gecko 实现证据链**（来源见文末，均只读）：

1. `[SecureContext]` 成员的条件由 Codegen 生成为
   `mozilla::dom::IsSecureContextOrObjectIsFromSecureContext(cx, obj)`
   （`dom/bindings/Codegen.py:4163-4170`）。
2. 该 helper 的定义：
   ```cpp
   inline bool IsSecureContextOrObjectIsFromSecureContext(JSContext* aCx, JSObject* aObj) {
     MOZ_ASSERT(!js::IsWrapper(aObj));
     return JS::GetIsSecureContext(js::GetContextRealm(aCx)) ||
            JS::GetIsSecureContext(js::GetNonCCWObjectRealm(aObj));
   }
   ```
   （`dom/bindings/DOMJSClass.h:68-72`；`PreflableDisablers::isEnabled` 在 `:130` 调用它。）
   即：**调用者 realm 是安全上下文，或对象来自安全上下文，二者之一成立就暴露**。注释明确
   写道：暴露取决于**运行代码的权限**，系统主体可在非安全 realm 上访问 secure API；并特别
   说明“对访问安全网页的 expanded principal globals（如 frame scripts），检查 context realm
   不适用，因此回退检查对象是否来自安全上下文”。
3. Xray 路径传的 `obj` 是**目标（页面）对象**，不是 Xray wrapper：
   `XrayResolveOwnProperty(cx, wrapper, obj, ...)` → `XrayResolveProperty` →
   `pref.isEnabled(cx, obj)`（`dom/bindings/BindingUtils.cpp:1634-1640, 1752-1789, 1829-1874`），
   且 helper 内含 `MOZ_ASSERT(!js::IsWrapper(aObj))`。所以 `GetNonCCWObjectRealm(obj)` = 页面 realm。
4. 内容脚本 sandbox 的 realm 是否安全？`CreateSandboxObject` 只在
   **系统主体**或**以安全上下文窗口作为 SOP/global 创建**时才 `setSecureContext(true)`
   （`js/xpconnect/src/Sandbox.cpp:1287-1338`）；realm 标志默认 false
   （`js/public/RealmOptions.h:242`）。`ExtensionContent.sys.mjs` 的常规内容脚本用
   `Cu.Sandbox([contentPrincipal, extensionPrincipal], { sandboxPrototype: contentWindow,
   wantXrays: true, isWebExtensionContentScript: true, ... })` 创建
   （`toolkit/components/extensions/ExtensionContent.sys.mjs:1077` 起）：第一个参数是
   **expanded principal**，不是系统主体也不是窗口，因此 sandbox realm **不会**被标记为
   安全上下文。

**据此的推断**：内容脚本在普通 http 页面上访问页面 `crypto.randomUUID` 时，
调用者 realm（sandbox，非安全）与对象 realm（页面，非安全）都为 false ⇒ **不暴露**；
在 https 页面上对象 realm 为安全 ⇒ 暴露，与用户实机 https PASS 一致。上面的独立基线
对照为该推断提供了实际失败证据。

**仍未闭合的部分**：

- 未取得内容脚本精确堆栈，因此“driver 初始化抛错”与“内容脚本 returned invalid result”
  之间的精确因果链属**高置信推断**，不是逐帧堆栈证据。
- 未排除某些 Firefox 版本/路径以其他方式把扩展内容脚本 sandbox 标为安全上下文。

**修复与当前状态**：修改为用 `view.crypto.getRandomValues(new Uint8Array(16))` 生成
v4 UUID（`getRandomValues` 不受安全上下文限制，且跨文档/调用者语义一致）。该改法在
“randomUUID 可用”与“不可用”两种结论下都正确：可用时仅换一种取随机数方式，不可用时
才真正避免初始化失败。**修复已具备失败对照，纳入集成后用新版实机复验闭环**；若复验
证明原 `randomUUID` 路径本可用，此改动可按需回退（无行为损失）。

## P2——未修的代码风险（低频/边界，均未实测为缺陷）

- **`error instanceof Error` 的跨 realm 兜底（低风险）**：错误映射依赖
  `error instanceof Error` / `instanceof FirefoxDomError`（`firefox-dom.ts` catch 分支）。
  0.0.136 实机证明 Firefox 绑定层抛出的 TypeError 在此为真；仅当错误来自另一
  compartment 且未跨世界包装时才会退化为 `String(error)`。未改。
- **`ariaVisible` 的隐藏语义可能窄于 UA 实现（低置信，未证实）**：`isInaccessible` 依据
  `display:none`/`visibility:hidden`/`aria-hidden`/`hidden`，并叠加我们的 `inert` 检查。
  若某浏览器以 `content-visibility: hidden`（而非 `display:none`）隐藏子树，snapshot 可能
  包含不可见节点。属“隐藏节点可能存在差异”的声明范围，未证实 Firefox 当前如此，未改。

## 待实机验证（覆盖缺口，不是缺陷）

以下功能**尚未**在真实 Firefox 跑过，只记录待办，不据此判定有 bug：

- 输入类命令的真实语义与效果：`fill`/`type`/`press`/`check`/`uncheck`/`setChecked`/
  `selectOption`/`hover`/`focus`/`blur`（代码层 realm 与原语选择正确，未实测）。
- iframe/frame 相关：frame 读已通过；`frameLocator` 与 frame 内 fill/click 已由
  [firefox-frame-shadow-console-fix.md](firefox-frame-shadow-console-fix.md) 增加无
  `getBoxQuads` 的严格路径，**待实机复验**（普通 iframe、带边框/内边距、遮挡、变换拒绝）。
- 真实页面的隐藏/aria-hidden/inert 子树过滤（0.0.136 仅覆盖 JSDOM 语义）。
- 复合跨 shadow CSS（如 `#shadow-host input`）：链式 locator 的根 shadow 遍历已修，
  复合 CSS 仍不支持；其超时需要与验收 client/request 同 5000ms 截止区分后再定性。
- 截图 `labels`、logs、network 等（多数属其他 owner 的文件）。
- **非可信 HTTP 页面**的 driver 初始化：独立基线已用
  `http://localtest.me:<loopback fixture port>`（非潜在可信 origin，页面自身
  `isSecureContext=false`、`crypto.randomUUID=undefined`）取得失败对照，`127.0.0.1`
  对照正常。剩余为**并入 crypto 修复后用新版实机复验闭环**。注意反例必须是**非可能可信
  origin**：`127.0.0.1`/`localhost`/`*.localhost` 本身是潜在可信 origin（安全上下文），
  不能用作 http 反例。

## 平台已声明限制（非缺陷，不回退）

- 不产生可信原生输入：DOM 合成事件 `isTrusted=false`；`hover` 不改原生 `:hover`；
  浏览器快捷键与系统剪贴板明确拒绝（`firefox-dom-input.ts:308-317`）。
- closed shadow DOM 不可读；跨源 iframe 走扩展 frame 身份；`about:`/特权页/受限域不可控。
- snapshot 是 DOM/ARIA 而非 Chrome 原生 AX 树，隐藏节点与名称可能有差异。
- evaluate 需 Firefox 153+ 与可选 userScripts 权限；ref 不可跨执行世界。
- frame 检查曾依赖 `getBoxQuads`。**更正（2026-09-12 实机基线）**：本条原有结论“非 Pref
  门控、内容脚本可见”是**错的**，当时只读了 WebIDL 的 `Func=` 注解，没有追 C++ 实现。
  `nsINode::HasBoxQuadsSupport` 实为
  `xpc::AccessCheck::isChrome(js::GetContextCompartment(aCx)) ||
  StaticPrefs::layout_css_getBoxQuads_enabled()`（`dom/base/nsINode.cpp:3995-3998`），
  且 `layout.css.getBoxQuads.enabled` 默认 `false`
  （`modules/libpref/init/StaticPrefList.yaml`）。内容脚本不是 chrome，因此**stock Firefox
  上 `Element.getBoxQuads` 不存在**，实机基线证实所有 frame 动作被
  `unsupported-capability` 拒绝。已改为：有 `getBoxQuads` 时保留原校验；缺失时用严格
  可证明的 client rect/border/padding 计算 content quad，详见
  [firefox-frame-shadow-console-fix.md](firefox-frame-shadow-console-fix.md)。

## 逐类核对：未发现其它已确认问题

| 审计类别 | 结论 | 关键证据 |
| --- | --- | --- |
| DOM/WebIDL 方法提取丢 `this` | 未发现其它问题 | 0.0.136 的 `getComputedStyle` 是唯一一处；全文件扫描无未被调用的 DOM 方法引用，3 处 `getComputedStyle` 均为方法调用或已绑定 helper |
| 第三方库默认回调 | 未发现其它问题 | `dom-accessibility-api@0.7.1` 仅 `isInaccessible` 有默认解构（`is-inaccessible.mjs:17/48`）；`computeAccessibleName` 默认 `safeWindow(root).getComputedStyle.bind(window)`（`accessible-name-and-description.mjs:226/232`、`util.mjs:25-32`）；`getRole` 不用 computed style |
| 跨 iframe/Window realm 构造器 | 未发现其它问题 | DOM 构造器全部为 `view.X`/元素自身 `defaultView`；`XMLSerializer`、`MutationObserver`、`PointerEvent`、`MouseEvent`、`KeyboardEvent`、`InputEvent`、`Event` 均按元素所在文档取 realm |
| 跨 realm `instanceof`/原型/setter | 未发现其它确认问题 | 无 `instanceof HTML*`；元素判定用 `localName`；`setNativeValue` 用 `element.ownerDocument.defaultView.HTMLInputElement.prototype` 的原生 setter 并 `.call(element)` |
| Shadow DOM | 未发现其它问题 | `composedParent` 走 `assignedSlot`/`parentElement`/ShadowRoot.host；`allElements`、snapshot 递归 shadowRoot，slot 用 `assignedNodes({flatten:true})` |
| 可见性/ARIA 语义 | 见 P2 第二条 | `isVisible` 逐 composed 祖先查 display/visibility + 包围盒；`ariaVisible` 逐 composed 祖先 `isInaccessible`（own-document view）+ `inert`；role options 与协议一致 |
| input 语义 | 未发现其它问题（未实测） | Enter/Space/Tab/方向键分支；`input[type=number]` 等 `selectionStart` 返回 null 时提前给出 `unsupported-capability`，不触发 `setSelectionRange` 的 `InvalidStateError` |

## 跨边界（只读核对，无改动）

- `firefox-resources.ts:60` 的 `firefoxId()` 用**扩展 realm** 的 `crypto.randomUUID`；
  扩展页是 `moz-extension:` 安全上下文，不受本 P1 影响。
- 其它 `firefox-*.ts` 未见 WebIDL 方法裸提取、realm 错用构造器或跨 realm `instanceof`
  元素判定；`firefox-popup.ts:10-11` 的 `instanceof HTMLButtonElement` 作用于同文档元素。
- manifest 版本与 changeset 版本递增按分工由协调者处理。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| 扩展 TypeScript（`mcp-extension exec tsc --project .`） | PASS |
| 扩展测试（`mcp-extension test --run`） | PASS，101 tests / 6 files（相对基线新增 1） |

未运行默认会启动 Chrome 的 `pnpm test`，未运行 runtime 端口/进程套件，未启动浏览器或
后台服务，未加载/重载扩展，未改用户配置。日志：`tmp/logs/tsc-final.log`、`tmp/logs/test-final.log`。

## 参考来源（Firefox 实现，只读核查）

取值自 `mozilla/gecko-dev` 与 `mozilla-firefox/firefox` 的 raw 内容，本地工作副本在
`tmp/research/`（已 gitignore）：

- `dom/webidl/Crypto.webidl`：`[SecureContext] UTF8String randomUUID();`（`getRandomValues` 无 `SecureContext`）。
- `dom/bindings/Codegen.py:4133-4180`：`[SecureContext]` 生成 `IsSecureContextOrObjectIsFromSecureContext(cx, obj)`。
- `dom/bindings/DOMJSClass.h:43-72,130`：helper 实现与注释（调用者 realm 或对象 realm）。
- `dom/bindings/BindingUtils.cpp:1634-1640, 1752-1789, 1829-1874`：Xray 解析把目标对象作为 `obj`。
- `js/xpconnect/src/Sandbox.cpp:1287-1338`：仅系统主体/安全 SOP 窗口才 `setSecureContext(true)`。
- `js/public/RealmOptions.h:197-242`：realm 安全标志默认 false。
- `toolkit/components/extensions/ExtensionContent.sys.mjs:1077-1084`：内容脚本 sandbox 以 expanded principal 创建。

## 需实机复验场景（优先级排序）

1. **P1 闭环（最高优先）**：加载含 crypto 修复的新构建，在已取得失败对照的
   `http://localtest.me:<loopback fixture port>` 上复验 `snapshot`/`locator` 进入 driver
   成功；同时保留 `127.0.0.1` 正向对照与页面 `isSecureContext`/`crypto.randomUUID`
   读数作为前后证据。
2. `fill`/`type`/`press`/`check`/`selectOption`/`hover` 的真实事件语义与效果。
3. iframe/frame：`frameLocator` 与 frame 内 fill/click 的无 `getBoxQuads` 严格路径
   （普通 iframe、带边框/内边距、遮挡仍拒绝、变换/缩放/zoom 拒绝）。
4. 真实页面隐藏/aria-hidden/inert 过滤，以及折叠 `<details>` 内容是否进入 snapshot。
5. 链式 locator 进入根 open shadow root；复合跨 shadow CSS 的超时与 5000ms 截止的关系。
