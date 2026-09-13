# Firefox swarm 修复与验收

当前状态：0.0.138 已由独立外部验收完成真实 Firefox 复验，结果为 **126 PASS / 0 FAIL / 2 SKIP**，全部非边界项通过。SKIP 仅两项既定边界（跨 shadow 复合 CSS、`target=_blank` 的 sourceTabId）。原 PR #6 分支已可更新；不合并到 dev/main。

## 基线

基线为 `f963175`（扩展 0.0.136）。此前四次修复分别处理 Firefox MV3 的 ws→wss 自动升级、后台空闲休眠、创建后的可选预热错误掩盖 tabId，以及可访问性库裸调用 Window.getComputedStyle。用户已通过建组、创建标签、snapshot、screenshot、execute page.title、release 的基础链路。

独立外部验收继续检查表单、Shadow DOM、iframe、导航、日志、网络、权限边界和空闲连接。0.0.136 原始基线为 **77 PASS / 8 FAIL / 1 SKIP**，详见 [基线报告](../../acceptance/firefox-swarm/report-2026-09-13-baseline-0.0.136.md)。复合跨 shadow CSS 后续被明确列为本轮未交付边界；这不是重新跑出的计数，也不表示该功能已修好。

## 分工

- CodeBuddy 平台 owner：DOM/WebIDL 接收者、跨 realm、iframe 几何、Shadow DOM、页面 console。
- Codex 操作 owner：注入结果、取消与资源身份、网络采集预算、navigate/back 完成观测。
- 独立 CodeBuddy 验收 owner：只修改 fixture/harness/报告，通过真实 Firefox 和本地 runtime 验证，不改产品代码。
- 独立 CodeBuddy 代码 reviewer：只读审查集成 diff，发现导航链和加载期 URL 更新缺口，交回实现者修复后复核。
- 协调者：核对代码与证据、纠正过度定级/测试口径、集成、版本与能力边界、串行检查、最终 PR 更新。

## 已集成修改

| 类别 | 修复与依据 |
| --- | --- |
| 注入结果 | 正式 inject/attach 校验目标 frame 的返回结果及 frame 级 error，防止脚本失败后仍提交 attach 归属；create 的可选预热仍是 best-effort |
| 取消与身份 | frame 路由/注入等待、资源落盘之后再检查取消；create 保存确切 native tabId 到请求上下文，释放后不继续分组 |
| 网络预算 | 2 MiB capture 同时计算全部在途原始字节及已保留 UTF-8 文本，每 body 64 KiB；处理 stream 完成顺序、旧回调、重定向、淘汰及停止，始终先转发原始响应 |
| HTTP 页面 | DOM document/snapshot/prepared-action ID 改用 getRandomValues 生成 v4 UUID；独立基线在非可信 HTTP origin 失败、同 fixture 在 loopback 正常，高置信指向 SecureContext API 暴露差异，修复效果仍待新版实机对照 |
| iframe | stock Firefox 的 getBoxQuads 受实现内的权限/pref 条件影响；无该 API 时仅支持可严格证明的无变换 content box，保留祖先遮挡与越界校验，几何有歧义则拒绝 |
| console | 使用当前内容脚本 realm 的 Reflect.apply 转发原 console；不把 sandbox rest array 交给页面 realm 的 apply，避免记录成功却破坏页面 console 调用 |
| Shadow DOM | 补 scope 根元素自身 open shadow root 的遍历，修复显式链式 locator；未实现单条复合 CSS 的跨 shadow 解析 |
| 导航 | 派发前监听同 tab 主 frame 事件，观测完成后核对实际 frame/tab；跟随后续导航链，更新加载中的 history/fragment URL，过滤可识别的旧 abort/completed，中断时子等待收敛 |

## 独立代码复核

首次审查发现导航状态过于严格：commit 后的页面重定向被当作失败，加载中 history/fragment URL 被忽略。返修已关闭这两项，新增状态测试覆盖后续导航、旧事件与无 documentId 的情况。

审查中的“超时必然内存泄漏”说法经可达根复核撤回：无外部根的 pending Promise 引用环可以被 GC；本轮让子等待显式收敛，但不将其称为已证实的内存泄漏。frame 与 tab URL 一致只证明当前事实自洽，不能证明导航的完备因果归属。

最终只读 reviewer 未发现 P0/P1 阻断，允许进入真实验收；这不替代浏览器测试。

## 0.0.137 实机结果

| 检查 | 结果 |
| --- | --- |
| runtime build / TypeScript | PASS |
| runtime unit | PASS，293 tests / 22 files |
| runtime integration | PASS，34 tests / 4 files |
| extension TypeScript | PASS |
| extension tests | PASS，130 tests / 8 files |
| Pi TypeScript / load-check | PASS，12 tools |
| Pi tests | PASS，97 tests / 3 files |
| Firefox / Chrome package smoke | PASS，归档内容、CRC 与 SHA256 核验 |
| 默认与现场 Firefox bundle | PASS，0.0.137，CSP 保留严格脚本策略 |

四套测试合计 **554 项**。完整日志在集成 worktree 的 `tmp/logs/*-final.log`。新增纯逻辑/DOM 测试不是原生 Firefox WebIDL、布局或事件时序的替身。

## 0.0.138 候选检查

导航改动与 stale 原因诊断由不同实现者交叉只读复核；诊断中“未知 ID 被猜为 replaced”的 P2 已修为仅关联确切的单条记录。显式 active network start 的契约校正也经独立复核。均未发现 P0/P1 阻断，但不代表实机通过。

协调者再次串行运行完整浏览器无关检查：runtime unit 293、integration 34、extension 150、Pi 97，合计 **574 项 PASS**；各包 TypeScript、Pi load-check、构建、Chrome/Firefox 归档 CRC 与 SHA256 均通过。日志在 `tmp/logs/138/`。新现场构建为 `extension/dist-firefox-swarm-138-localhost`；原已加载的 `extension/dist-firefox-swarm-localhost` 保持 0.0.137 未覆盖。

## 实机复验与边界

复验使用 [独立 harness](../../acceptance/firefox-swarm/README.md)，明确提供 runtime URL 与已加载版本，只操作独立 session 新建的 fixture/group/tab，完成后清理。不会修改用户权限、浏览器偏好、既有标签或重启共享 runtime。

0.0.137 独立实机结果为 **114 PASS / 6 FAIL / 2 SKIP**：iframe、console、HTTP driver、完整网络转发、取消与保活已通过，剩余四项稳定导航链失败与一次 stale-ref 导致的两项失败，详见 [0.0.137 实机报告](../../acceptance/firefox-swarm/report-2026-09-13-final-0.0.137.md)。

0.0.138 针对导航继续更新完成候选并重复核对 frame/tab 事实，仅受控暂存精确 NS_BINDING_ABORTED 且要求替代证据；stale-ref 改为精确关联的有界原因诊断（不削弱拒绝）；active network start 按契约替换前次 capture。0.0.138 离线 574 项 PASS、交叉复核无阻断后，由独立验收在真实 Firefox 复验。

## 0.0.138 最终实机结果

0.0.138 独立实机复验结果为 **126 PASS / 0 FAIL / 2 SKIP**，完整逐条记录见 [0.0.138 实机报告](../../acceptance/firefox-swarm/report-2026-09-13-final-0.0.138.md)。上一轮六项失败全部转 PASS：四项导航链返回真实最终 URL（meta `?via=meta`、location.replace `?via=location`、载入期 replaceState `?replaced=1`、载入期 hash `#frag`），`outcome-unknown` 与 `Error code 2152398850` 均未再出现；stale-ref 未复现，权威路径 `page.fill(aria-ref=e10)` 通过，负向用例正确带 `reason:"invalidated:action"`；active→start 网络替换契约 PASS。SKIP 仅两项既定边界。全矩阵 cleanup 两项 PASS，`tabs.discover` 无 fixture 残留。

明确保留的边界：

- DOM 输入不产生原生 trusted 事件，popup/target=_blank 可能被浏览器拦截，不绕过用户设置。
- CSS 在各 document/shadow root 内原生匹配；跨 host 用链式或 role/label/text，单条复合跨 shadow CSS 本轮不交付。
- 缺少 getBoxQuads 时拒绝变换、缩放、分数舍入等无法严格证明的 frame 几何，不以近似掩盖风险。
- navigate/back 对正在加载的标签在派发前拒绝；没有确认事件的同 URL/no-op 返回 timeout/outcome unknown，不重放。WebExtension 无 actionId，不能完备区分用户/网页并发导航。
- evaluate 仍需用户自愿授予可选 userScripts 权限，不自动开启；execute 是 DOM-compatible 子集，并非完整 Playwright/CDP。
