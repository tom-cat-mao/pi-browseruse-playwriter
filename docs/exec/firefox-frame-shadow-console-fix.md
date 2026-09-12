# Firefox 实机基线三项修复：frame 动作、page console 转发、根 shadow 链式 locator

来自独立验收基线
`../acceptance/tmp/firefox-swarm-acceptance/evidence-2026-09-12T17-19-23-746Z/`
（扩展 0.0.136，真实 Firefox，PASS 75 / FAIL 0 / SKIP 5）。本轮只修
`extension/src/firefox-dom*.ts` 及其测试、changeset、文档；其它 owner 文件未改。
三个修复各自独立提交，便于择取。

## 1. frame 动作被 `getBoxQuads` 拒绝（`eaf97fd`）

### 现象

同源与跨源 iframe **读取**成功，但 `frameLocator(...).locator(...).fill(...)` /
`click` 均返回
`unsupported-capability: Firefox getBoxQuads is required to verify the frame content box`，
`outcome=unknown`。

### 根因（更正此前审计结论）

此前审计只读 WebIDL 的 `Func=` 注解就断言“内容脚本可见”，是错的。C++ 实现是：

```cpp
bool nsINode::HasBoxQuadsSupport(JSContext* aCx, JSObject* /* unused */) {
  return xpc::AccessCheck::isChrome(js::GetContextCompartment(aCx)) ||
         StaticPrefs::layout_css_getBoxQuads_enabled();
}
```
（`dom/base/nsINode.cpp:3995-3998`），且 `layout.css.getBoxQuads.enabled` 默认
`false`（`modules/libpref/init/StaticPrefList.yaml`）。扩展内容脚本是 expanded principal，
不是 chrome，所以 **stock Firefox 不暴露 `Element.getBoxQuads`**。`checkFramePoint`
原实现硬性要求该方法，于是所有 frame 动作被拒。

### 修复

- 有 `getBoxQuads` 时：保留原路径与原校验（`assertFrameTransform` + content quad +
  `mapFramePoint`）。
- 缺失时：对整条 composed 祖先链要求**可证明的轴对齐**（`assertStaticFrameTransform`）：
  `transform` 必须是 `none` 或单位 matrix/matrix3d，`rotate`/`scale`/`translate`/`zoom`/
  `perspective`/`offset-path` 必须中性；再用 `getClientRects()`（必须恰好 1 个，非分片）、
  有限非退化 box、used border/padding 与 `clientLeft/Top`、`clientWidth/Height`
  的**精确一致性**计算 content quad（`frameContentQuad`）。任一无法证明精确的情形
  （分片、退化、非有限、边框/内边距分数像素导致四舍五入 client 值对不上）一律拒绝，
  不做 bounding-box 近似。
- 保留祖先 `elementFromPoint` 遮挡检查、视口越界检查与 prepared-action 身份校验
  （后者在 `firefox-dom.ts`，未改）。

### 回归

`extension/tests/firefox-dom.test.ts` 新增 4 例：可证明几何的 content quad 计算；
不可证明 box 的五种拒绝；严格无变换链的接受/拒绝矩阵；无 layout box 时拒绝。
JSDOM 无布局引擎，真实 client rect 场景由验收实机复验。

## 2. page console 转发导致页面 `console.log` 抛 `Permission denied ... length`（`08e88d4`）

### 现象

`logs` 里记录到页面 `console.log` 行之后，紧接着出现
`[error] Error: Permission denied to access property "length"`，位置是 fixture 页面脚本
自身（`index.html:90:75`）。记录器先记到日志，不代表转发成功。

### 根因

桥接用 `original.apply(pageView.console, args)`。`original.apply` 是**页面 realm** 的
`Function.prototype.apply`，它会读取 `args` 的 `.length` 与各索引；而 `args` 是
`exportFunction` 回调在**内容脚本 sandbox realm** 新建的 rest 数组。页面没有权限访问该
sandbox 对象，于是抛 `Permission denied to access property "length"`，并沿页面自己的
`console.log` 调用栈向上抛（所以报错行是页面脚本）。

### 修复

改为在内容脚本 realm 提取参数后再调用页面函数：
`Reflect.apply(original, pageView.console, args)`。`this` 仍为 `pageView.console`，
页面 `console.log` 正常执行。原有调用**不**包 try/catch，原 console 的异常继续向外抛，
不静默吞异常；不 cloneInto 任意对象、不扩大权限。

JSDOM 无法复现跨 compartment 权限错误，且不为它伪造浏览器 API，故未新增测试。

## 3. 根元素自身 open shadow root 的链式 locator（`bee0a4d`）

### 现象

`page.locator('#shadow-host input').fill('x')` 复合 CSS 超时（开放 shadow 根）。
先核对显式链式写法 `page.locator('#shadow-host').locator('input')` 是否同样失败。

### 根因

`allElements` 与 `selectElements` 的 CSS 分支只递归**已匹配后代元素**的 `shadowRoot`，
从不遍历**当前 scope 根元素自身**的 `shadowRoot`。因此以 `#shadow-host` 为 root 时，
其 shadow 子树完全不被搜索；document 级 locator 之所以能工作，是因为 `#shadow-host`
作为 document 的后代被收集后再进入其 shadowRoot。

### 修复

两处都补上 root 自身 open shadow root 的遍历。

### 边界（不要把链式修好等同全 CSS 穿透）

- 本次只修“**scope 根元素自身**的 open shadow root 遍历”，即
  `page.locator('#shadow-host').locator('input')` 这类**链式**写法。
- **单条复合 CSS 选择器跨 shadow 边界仍不支持**：`page.locator('#shadow-host input')`
  （或 `page.click('#shadow-host input')`）不会因为本修复而工作，因为 `querySelectorAll`
  本身不跨 shadow 边界，而我们**没有**实现跨 shadow 的复合选择器解析器（用户明确要求
  不为此写大解析器）。跨 shadow 定位应使用链式 locator（显式作用域）或 role/label/text 等
  会遍历 composed 树的引擎。
- 该复合 CSS 在验收基线上表现为 5000ms 超时：这是“等待未命中元素直到请求截止”的既有
  行为，而不是本修复的目标；其超时是否只是验收 client 与 DOM request 同为 5000ms 截止
  所致，需由 runtime/验收 client owner 区分后再定性，本文不判为完整 bug。
- 模型侧 capability 的全局 `limitations` 文案由协调者统一补充，本文只记录实现边界。

### 回归

新增 1 例：链式 CSS 与链式 role locator 均能命中 root 自身 open shadow root 内的元素
（修复前为 0 匹配）。该用例只覆盖链式写法，不覆盖也不声称覆盖复合跨 shadow CSS。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| 扩展 TypeScript（`mcp-extension exec tsc --project .`） | PASS |
| 扩展测试（`mcp-extension test --run`） | PASS，106 tests / 6 files（相对基线 +6） |

未运行默认会启动 Chrome 的 `pnpm test`，未运行 runtime 端口/进程套件，未启动浏览器、
未加载扩展、未改用户配置。日志：`tmp/logs/tsc-round2b.log`、`tmp/logs/test-round2.log`。

## 需实机复验（由验收 owner 执行）

- 普通同源/跨源 iframe 的 `frameLocator` fill/click 成功。
- 带边框、内边距、偏移的 iframe 命中位置正确。
- 被遮挡 iframe 命中仍被拒绝（遮挡检查未回退）。
- 带有 transform/独立 rotate/scale/translate/zoom/perspective 的 iframe 被明确拒绝。
- 复合 CSS `#shadow-host input` 的超时是否只是 5000ms 截止问题。
- 页面 `console.log` 不再产生 `Permission denied ... length`。

## 边界

未扩大权限、未改 CSP/协议/ownership/取消语义、未删除安全检查、未新增 mock 或伪造浏览器
API、未改 manifest 版本（由协调者递增）。JSDOM 不作为 Firefox 品牌/权限行为证据。
