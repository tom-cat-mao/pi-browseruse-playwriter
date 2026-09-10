---
title: 接续现有标签与外链阅读执行计划
description: 在现有 Pi Browser Use 上补齐现有标签发现、原地控制和外链往返。
prompt: |
  用户原文：
  可以啊，可以那个可以写，然后你去写那个执行文档什么的，然后你就像上面一样的那个那个操那个修改方式吧，然后咱们来试一下。
  然后那个我需要说一些，就是我我自己想到的一些可能出现的问题点。
  就比如说我有现在有多个这个Chrome的这个Chrome的Profile或者是多个Window，
  那我现在要打开的哪个Tab什么这个问题，它是不是都能列出来？
  列出来之后，可能我就是和，就是因为这本身就是一个Agent用的嘛，
  就是我可能跟它说一些细节，它能从这里面找出来，我说的是哪个Tab，大概这样。
  然后就是，呃，还有另外一个，就是比如说，呃，这个Tab里面，
  比如说我让它在这个就是我现在看这个Tab里面有一个外链，
  它点开这个外链之后，这个外链形成一个新Tab去了。
  那按照人类的这个阅读逻辑，它应该点击这个进去了之后，
  它可能就直接跳到另外一个页面，跳到另外一个页面，
  它应该读另外一个页面的内容。这个它能做到吗？
  然后，呃，然后直接读另外一个让，这个是这个问题。
  然后就是它比如说这个外链它读完了，它退回去，
  退回去还能退到原来那个点吗？我能想到的是大概这些，
  还有就是，最后一个问题，其实就一个很简单的问题，
  就是这个方案是不是一定需要就是视觉模型，就是非视觉模型可以吗？
  这个我知道Playwright它是可以只读就是DOM呀，读这些内容就可以那来完成这个任务的。
  但是我还是要问，就是这个现在是纯识图吗？
  还是说视觉还是说非视觉模型读这些内容也可以？大概这些内容来讨论一下吧。
  已确认背景：现有标签需要完整控制，不是只读或临时借用；不要求用户复制URL、
  先建组或理解归属模型。不要过度设计。沿用feature branch/worktree、
  external agent实施、独立验收、用户配合浏览器、PR合并清理的方式。
  依据 @README.md @docs/exec/browser-runtime-contract.md
  @playwriter/src/skill.md @playwriter/src/browser-protocol.ts
  @playwriter/src/managed-executor-worker.ts
  @playwriter/src/managed-executor-facade.ts
  @extension/src/background.ts @extension/src/managed-groups.ts
  @extension/src/resource-registry.ts @pi/extensions/index.ts。
---

# 状态与目标

基线：main@1c622a6。分支：feat/existing-tab-control。
工作树：tmp/existing-tab-control/integration。
用户已批准实施；先在此工作树修改与完成无浏览器检查。
浏览器验收前通知用户准备/重载扩展，不擅自操作当前浏览器。

当前状态：功能61456ba与短审修复dcf1a91已提交（扩展0.0.129）。
协调者重跑类型检查、runtime234项unit/34项integration、extension36项、
Pi64项及12工具加载检查通过；修订后build/smoke及目标回归亦通过。
独立CodeBuddy20已核对补丁。首轮真机发现两profile仅有restricted newtab，
原地主场景未执行；用户随后改为两个可接入的Linux.do页面并清除旧测试资源。
普通新建标签回归确认一个实际时序缺口：已连接worker收不到后创建目标的
attached事件。Codex22已以a6cc285只修relay的inventory/target通知协调，
保留owner范围与去重；协调者重跑类型检查和38项managed-relay测试通过。
原始验收报告见existing-tab-control-live-acceptance.md，不以修复代替真机通过。
第二轮真机已通过原地attach、外链新tab/独立popup读取与返回、普通history
back、非视觉AX路径与跨session拒绝；原页草稿与scroll在往返后保持。
剩余：release后重新attach的首动作早于Playwright Page初始化，c37a0ba已
增加明确target的有界事件等待；协调者typecheck及46项目标回归通过。
hash点击被浮动toolbar遮挡，不是后退实现失败；报告已纠正，复测先正常隐藏
工具栏或避让fixture布局，不强制点击，不把cancelled视为未执行后盲重试。
下一步用户只需重启19991 runtime，定向复测重接与hash back，不重跑整套。
扩展仍为0.0.129（本树extension/dist-acceptance），无须重载；不替换现有
19989/19990进程或全局Pi配置。
共享契约见下文“共享契约（本轮新增，唯一写入处）”。

目标只有一句话：**用户在页面上做到一半，告诉 agent 接着做，agent 就在原标签继续。**
复用现有读取、点击、填写、导航与隔离执行能力，不重写底座，不做新 agent。

# 四个使用场景

## 1. 找到用户说的标签

- 按需列出已安装并连接本扩展的 profile 下，各窗口中的现有标签。
- 返回真实标识、浏览器/profile、窗口、标题、URL、激活标签及窗口焦点信息。
- 可按 profile、窗口、标题或 URL 缩小列表；找标签由 Pi 根据用户描述完成。
- 每个窗口都可能有激活标签；用户切回终端后浏览器也可能不再有焦点。
  这些信息只用于定位，不伪装成全局唯一的“当前标签”。
- 能明确定位就直接继续；确有多个同样候选时，agent 简短询问，不擅选第一项。
- 只列连接到此 runtime 的 profile；未装扩展、离线或浏览器禁止访问的页面，
  清晰说明范围。列表是元数据发现，不代表已经读取全部标签正文。

## 2. 在原标签完整操作

- 为选中的现有标签建立当前 Pi 会话的控制记录，返回正常的 managed tabId。
- 不重新打开、不刷新、不移动窗口或已有分组，不清空滚动位置、表单和页面现场。
- 接入后支持现有 page 工具的完整操作，不另分“只读模式”。
- 逻辑归属自动处理；用户不需要先建组。现有自动新建任务标签的流程继续可用。
- 已属本会话的标签复用；其他会话正在控制的标签明确提示，不抢控制。
- 用户明确释放才停止控制；任务结束不自动关闭用户原标签。

## 3. 外链打开新标签后继续阅读

- 复用已有 popup 登记，补齐来源标签关系和可供 agent 使用的新 tabId。
- 点击结果或随后标签查询告诉 Pi：源标签、新开的标签及其 URL/标题。
- 阅读外链时，Pi 接着读取新标签，而不是一直对原标签取快照。
- 不使用“最后一个标签”猜目标；多窗口/profile 下按真实来源关系定位。
- 新标签按来源继承当前会话控制；保留原标签，不为了阅读而重新导航原页面。
- 不增加全局隐式 currentPage；agent 记住来源/目标 tabId 并自然接续操作。

## 4. 读完返回

- 外链开新标签：切回保留的原 tabId，原页面通常仍在原来的滚动和输入位置。
  不关闭再重建，也不拿原 URL 再导航一次。
- 外链在原标签内跳转：调用正常浏览器后退，不以 goto(oldUrl) 伪装后退。
- 同标签后退时，滚动和表单恢复取决于站点及浏览器历史缓存；不能承诺所有站点
  都精确恢复。此轮不做通用页面状态备份或恢复引擎。
- 原标签被用户关闭或站点自行改变时如实反馈，不悄悄补开相同 URL。

# 非视觉模型

现有主路径就是 DOM/无障碍树的文本、角色、名称与 snapshot refs，不是纯识图。
纯文本模型可完成发现标签、阅读正文、点击、填写、读新页面和返回。
截图只是可选补充；纯 Canvas、图片内文字或只有视觉提示的界面可能需要视觉能力。
本功能验收以文本快照和 DOM 读回为主，不依赖模型看截图。

# 实施范围

- 扩展：现有标签/窗口发现、原地接入、切换标签；已有归属注册表识别原地标签，
  不把“不在新建任务组中”误判为用户释放，不将旧组的其它标签一并接管。
- Runtime：只新增兼容的发现/接入/切换操作与来源关系字段，保留已有协议和
  session/target 校验；新能力不可用时明确提示，不回退到猜标签。
- Executor：复用页面动作，补新标签结果关联和必要的普通后退入口。
- Pi：在现有工具中增加相应操作，把候选、新标签和来源标识放进模型可见文本；
  工具说明遵循“看用户现场并接着做”，不让用户处理内部参数。
- 具体新增字段由实施前的小型共享契约固定；不为选标签造审批 UI、页面路由器
  或自定义任务状态机，不扩展 Firefox、PDF、全局键鼠和冷启动重绑定。

# 共享契约（本轮新增，唯一写入处）

编译类型来源：playwriter/src/browser-protocol.ts。新增字段/操作以此为准，
扩展、relay、executor、Pi 不再各自猜接口。全部为**向后兼容新增**：
旧 WS method/result 格式、旧 manifest/registry、旧客户端行为均不变。

## 新增字段

- `BrowserTabOrigin = 'task' | 'existing'`
  - `task`：原有自动建组/受控新建的标签（默认语义，缺省等同）。
  - `existing`：原地接入的用户现有标签及其原地来源的子标签。
- `BrowserGroup.origin?`：内部逻辑组来源。`existing` 组**没有** chromeGroupId
  绑定，不参与 Chrome 分组，也不因“不在任务组里”被释放。
- `BrowserTab.origin?` / `BrowserTab.sourceTabId?`
  - `sourceTabId`：外链新标签的来源 managed tabId（点击结果或随后列表可查）。
- `BrowserCapabilities.existingTabControl?: boolean`（optional，旧 profile 不失效）。
- `BrowserResultData.candidates?: BrowserTabCandidate[]`（发现结果，元数据）。

## candidateId（发现目标的真实标识）

- 格式：`pcdt:<profileId>:<browserEpoch>:<chromeTabId>`，由
  `buildTabCandidateId()` / `parseTabCandidateId()` 生成与解析（放协议文件，
  各层共用，不各写一份正则）。
- 不是 managed tabId，不替代 groupId/tabId 的 opaque 身份；它只描述
  “某次发现到的那个真实标签”。
- attach 必须用当前 browserEpoch 校验：过期发现 id 直接失败，绝不误接其它标签。
- 发现结果随取随用，无服务端缓存，SW 重启或 relay 重启后重新发现即可。

## 新增 operation

| kind | 参数 | 处理位置 | 语义 |
| --- | --- | --- | --- |
| `tabs.discover` | `profileId?` `windowId?` `query?` `includeManaged?` | relay 扇出到已连接 profile，扩展列举本 profile | 元数据发现（URL/title/window/active/focus），不读取页面正文 |
| `tabs.attach` | `candidateId` | relay 按 profileId 路由 + epoch 校验，扩展原地接入 | 返回正常 managed tabId；内部建 `existing` 组，不搬动窗口/分组/刷新 |
| `tabs.activate` | `tabId` | 扩展 | 把原标签设为所在窗口的 active 标签（不抢 OS 焦点、不重建、不 goto） |
| `page.back` | `tabId` | executor | 浏览器历史后退（`page.goBack()`），不是 goto(旧 URL) |

`tabs.list` 新增可选过滤 `sourceTabId?`（查“某标签点出来的新标签”）；
默认仍严格只列本 session，语义不变。

# 执行方式

1. 上述用户可见行为已获确认，开始实施；当前阶段不运行浏览器测试。
2. 默认一个 CodeBuddy 在独立 feature worktree 做端到端小改动，避免多端各自
   猜接口。协调者核对 diff；如确需拆分，再给第二个 agent 不重叠的文件范围。
3. 修改 TypeScript 后跑相关包 typecheck，扩充已有的归属/relay/Pi 测试；
   扩展版本递增，公共包增加 changeset，不手改公共版本号或 CHANGELOG。
4. 实施完成后，由另一个全新 CodeBuddy 做一次短审查及下述场景验收。
   不重跑无关矩阵，不以测试脚本错误为产品问题，不追无意义的边缘条件。
5. 浏览器测试前通知用户加载测试构建；不修改当前全局 Pi 配置，不碰日常
   runtime/19988，不自动重启或操作用户正在使用的 Chromium。
6. 修复实际发现的问题，复测对应场景。经用户确认后走 PR 合并及工作树清理。

# 有意义的验收，仅五项

1. 两个 profile、多个窗口和相似标题：列表足够区分，并能选择正确的原标签。
2. 用户原标签已有滚动和输入内容：原地接入不改变现场，接着点击/填写成功。
3. 点击外链新开标签：找到真实新 tabId，能读新页面，再切回原标签与原位置。
4. 原标签内跳转：正常后退回来源页，不重开标签，并如实验证站点恢复情况。
5. 用纯文本快照/ref 完成上述关键操作；其它会话控制的标签不被抢占，原有
   新建受控标签流程不回归。
