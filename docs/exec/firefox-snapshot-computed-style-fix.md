# Firefox snapshot / role locator 的 getComputedStyle 绑定修复

0.0.136。分支 `fix/firefox-tab-create-readiness`，基于 `8ca3e54`（0.0.135 create 修复）。
仅修 `firefox-dom-locators.ts` 的这一个品牌校验问题，不回退已提交的 create/keepalive 修复。

## 现象

用户实机 0.0.135：groups.create、`tabs.create`（返回 tabId）、screenshot、
`execute page.title()` 均成功；`browser_snapshot` 报
`'getComputedStyle' called on an object that does not implement interface Window`，
`code=execution-failed`、`outcome=not-started`。属部分成功，snapshot 是独立缺陷。

## 根因

调用链（只读定位，证据均在源码内）：

1. `takeSnapshot` 逐元素 `!ariaVisible(element)`：`extension/src/firefox-dom.ts:397`。
2. `ariaVisible` 调用 `isInaccessible(current)`：`extension/src/firefox-dom-locators.ts:80`。
3. dom-accessibility-api 0.7.1 `dist/is-inaccessible.mjs:17` 把
   `element.ownerDocument.defaultView?.getComputedStyle` **解构成裸函数**，随后在
   `:24`（visibility）与 `:58`（display，经 `:30` 传入 `isSubtreeInaccessible`）以
   `getComputedStyle(element)` 形式裸调用。
4. Firefox 的 `Window.getComputedStyle` 是 WebIDL 方法，要求 `this` 为 Window；裸调用
   `this=undefined` 即抛该 TypeError。字符串与实测逐字一致。
5. 范围不止 snapshot：role locator 过滤同样走 `ariaVisible`
   （`firefox-dom-locators.ts:199`），故一并受影响。`isVisible`（`:71`）是方法调用，
   `computeAccessibleName` 已使用 `window.getComputedStyle.bind(window)`
   （`accessible-name-and-description.mjs:232`），`getRole` 不用 computed style，均无此问题。
6. 错误映射：本次 snapshot 属只读命令，`firefox-background.ts:1354-1379` 不置
   `context.started`，内容脚本 `firefox-dom.ts:1058-1061` 返回 `execution-failed` +
   `not-started`，与实测字段吻合。role locator 也可能用于点击等修改动作，不能把
   所有 role 操作都视为只读，其 outcome 仍遵守原有请求语义。

## 修复

`firefox-dom-locators.ts` 新增 `computedStyleOf`：从 `element.ownerDocument.defaultView`
取 view，再以 `view.getComputedStyle(element)` 方法形式调用；无 view 时抛原有明确
TypeError。`ariaVisible` 改为
`isInaccessible(current, { getComputedStyle: computedStyleOf })`，该实现会随选项传入
`isSubtreeInaccessible`（`is-inaccessible.mjs:29-31`），两个裸调用点一次修好；每个
same-origin iframe 文档各自解析自己的 view，不绑定外层 global window。

未扩大权限、未改 CSP/协议/ownership/取消语义，未删除可访问性库或放宽隐藏节点过滤，
未改 `computeAccessibleName`，未新增代码注释。

## 回归

`extension/tests/firefox-dom.test.ts` 新增 `Firefox DOM ARIA visibility from the element
own document`，使用既有 JSDOM 模块与真实 DOM：

- display:none / visibility:hidden / aria-hidden 祖先 / inert 子树被排除，可见节点保留。
- own-document same-origin iframe：断言 iframe view 与外层 window 不同，iframe 内
  display:none 被排除，经元素自身文档取 view。
- role locator 应用同一 `ariaVisible` 过滤：被 aria-hidden 的按钮不出现在 role 选择结果。

明确边界：JSDOM 的 `getComputedStyle`（`jsdom/lib/jsdom/browser/Window.js:908-909`）
闭包捕获自己的 window、不看 `this`，因此这些用例**不能复现 Firefox 的 native this
品牌检查**，只能验证不同文档中的隐藏语义与 role 过滤未回归。未新增 mock、
未伪造 Window 品牌校验、未改写 getComputedStyle。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| 扩展 TypeScript | PASS |
| 扩展测试 | PASS，100 tests / 6 files（新增 3） |
| 默认 Firefox bundle | PASS，0.0.136，127.0.0.1:19989 |
| snapshot localhost bundle | PASS，0.0.136，localhost:19991 |
| Firefox package smoke | PASS，ZIP / unsigned XPI + SHA256 |

未运行默认会启动 Chrome 的 `pnpm test`。

## 产物

- 默认：`extension/dist-firefox`（0.0.136，127.0.0.1:19989）。
- 本 worktree 现场用：`extension/dist-firefox-snapshot-localhost`
  （0.0.136，localhost:19991）。**未覆盖**用户已加载的
  `extension/dist-firefox-tab-create-localhost`（0.0.135）与
  `extension/dist-firefox-lifecycle-localhost`（0.0.134）。
- 打包：`dist-release/pi-browser-use-firefox-extension-0.0.136.zip` 与
  `...-0.0.136-unsigned.xpi`（附 `.sha256`）。

## 用户实机基础链路验收

用户加载 0.0.136 后，在原 Pi 会话完成 profiles → 创建组 → 创建 example.com 标签 →
snapshot → screenshot → `execute return await page.title()` → release，全部成功。
snapshot 返回 5 行、2 个引用和正确的 Example Domain 页面信息；已释放测试标签控制权，
未关闭页面。协调者另从实际 runtime 确认连接的 Firefox 扩展版本为 0.0.136。
这证明本轮真实 Firefox 快照已不再触发原来的 Window 接收者错误，不等于全部页面能力通过。

以下仍为 **NOT RUN**：`role=`/`name=` 定位后的填写/点击、真实页面隐藏节点过滤、
iframe 内 snapshot 以及网络/日志等完整能力矩阵。需要在独立验收阶段继续验证。
本实现未加载/重载扩展，未启动真实浏览器，未改用户权限或已有标签。
