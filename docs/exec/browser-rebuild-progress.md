---
title: Pi Browser Use 重构执行进度
description: 工作树、任务归属、合并顺序与验收状态。
prompt: |
  按用户授权的多 agent worktree 工作流记录实际进度。
  参考 @docs/exec/browser-rebuild-plan.md
  @docs/exec/browser-runtime-contract.md @playwriter/src/browser-protocol.ts。
  只记录已执行事实；不得把未执行 Chrome 验收标为通过。
---

# 当前阶段

Step 3主体已完成：候选6aeb91c、扩展0.0.127在用户隔离Chrome复验
22 PASS / 0 FAIL / 4 SKIP，run 0546d44d。第一轮实际问题全部闭环。
停止新增测试和设计，转入交付收尾；明确保留未测项，不抬高无意义门槛。
用户明确要求不阻塞等待 agent，需要 Chrome 时通知用户后停下。
全部执行 agent 使用默认 model/effort；禁止 Reasonix。
codebuddy-6 原先显式 effort=high，已依用户要求停止，由默认配置的
codebuddy-11 接续同一工作树，保留未提交修改。其余四个执行 agent 均未
指定 model/effort，无需重启。

# 任务与所有权

| 工作流 | agent / task | 分支 | 状态 |
| --- | --- | --- | --- |
| E 工具链/发行/日志 | CodeBuddy11/15 | feat/browser-runtime-foundation | eab8301已集成，产品README/legacy测试入口完成 |
| A 扩展归属/分组 | CodeBuddy7/18 | feat/browser-owned-groups | 3e638d1已集成，0.0.127真机复验通过 |
| B Managed relay | CodeBuddy / codebuddy-8 | feat/browser-managed-relay | 107d274 已集成，worker静态接线完成 |
| C 独立执行器 | Codex / codex-9 | feat/browser-isolated-executor | 33e6ab2已集成，独立复验通过 |
| D Pi 工具 | TRAEX / traex-10 | feat/browser-pi-tools | 2e54b87已集成，独立复验通过 |
| 集成/共享契约 | 协调者 | feat/pi-browser-rebuild | 进行中 |
| 中期独立审查 | 全新 CodeBuddy / codebuddy-12，只读 | 集成分支 | 已完成，见browser-midpoint-review.md |
| 验收脚本准备/真机执行 | CodeBuddy13/16/17 | feat/browser-acceptance-harness | 0546d44d真机22/0/4，已结束 |
| 最终独立验收 | 全新CodeBuddy / codebuddy-14 | review/browser-rebuild | a4e1669无浏览器PASS+134233d差异通过；Chrome INCOMPLETE |

各 worktree 位于主仓库 tmp/swarm-rebuild/：foundation、extension、relay、
executor、pi-tools、integration。主目录 main 未修改。

# 已完成

- 主目录 main 8cbf68b，未跟踪 ppe-accept.jpg 保留。
- 集成分支合入上游 6e563c8，合并提交 f7cef2d。
- 计划、契约、共享类型提交 859910d。
- 独立 tsc 检查 browser-protocol.ts 通过。
- 已创建五个实现 worktree 并派发任务；没有等待 agent。
- fork origin = tom-cat-mao/pi-browseruse-playwriter。
- gh 默认仓库可能指向上游，所有后续 GitHub 操作显式 -R fork。
- fork issues 禁用；参考上游 issue 时使用完整来源，不发上游 PR。
- E 基础设施 1107228 已合入集成分支；A 主体 20c5fb5/bf29f36 已合入。
- 集成工作树 pnpm 10.18.1 frozen install 成功；Playwright 子模块已本地
  reference 初始化到2074cbb1d并保持playwriter分支。
- 协调者在集成树重跑 runtime build + test:unit：28/28通过，无Chrome。
- E 复核要求：并发启动不truncate日志、非法HTTP不判down、endpoint隔离、
  token子进程测试、fork默认构建命令不能指向上游ID/19988/商店。
- A 复核要求：持久化失败不假ready、scoped持久去重、per-group并发、
  用户释放时失败cleanup不删用户tab、旧epoch数字不访问Chrome、
  popup先归属/入组再attach、用户改名事件、全局取消不自动重控。
- B 543b636已合入：CDP URL token、request指纹去重、tab.resolve已实现。
- 协调者再次在集成树跑 typecheck，runtime 123/123测试、extension
  11/11纯状态测试通过（无Chrome）。
- E追加7d0f92b已合入：非破坏日志、端点分类、真实token/并发启动测试。
- B二审要求：root/nested CDP绕过防护、parent释放即撤销iframe权限、
  流式body限额、队列执行前再校验owner/epoch/释放。
- E二审要求：ownbin不覆盖全局playwriter、production fork不退19988、
  CI加入各新模块/Pi/extension测试、logger序列化与既有文件计量。
- A b3fa70b、B0364558、E4500349已合入；协调者重跑 runtime build、
  249/249无浏览器runtime tests、23/23extension state tests。
- Pi旧原型59/59测试和typecheck仍过，但D新版尚未合入，这不是新版验收。
- 已创建Draft PR #1：
  https://github.com/tom-cat-mao/pi-browseruse-playwriter/pull/1
- 首次push7a5fb61的GitHub CI通过。
- 1583c00两次Linux CI在Vitest进程池报ERR_IPC_CHANNEL_CLOSED，已交E
  查明根因，不能以本地通过替代。GitHub run34464546572/34464543374。
- B3909817已合入：控制取消转发、矛盾inventory拒绝、nested CDP包装拒绝。
- 独立acceptance工作树现为feat/browser-acceptance-harness；新CodeBuddy13
  编写带显式授权门槛的Chrome验收脚本（只准备/dry-run，不启动Chrome）。
  最终验收须在C/D完成后另开新agent针对冻结候选提交进行。
- 中期全新CodeBuddy只读审查已启动，避免实现者自验收。
- 契约补全控制请求取消必须透传extension、旧WS代际结果不得送新socket、
  pending/completed create ledger防SW中断重复创建；A/B在各自分支落实。
- E2346d18已合入，明确将locator-selector.test.ts移出无浏览器套件；
  此前249项及部分回归包含该测试，它实际上启动过隔离headless Chromium。
  协调者已向用户更正；未访问日常Chrome或重启19988。不能将此前执行
  统称为纯无浏览器。后续逐项检查套件并按授权门槛运行。
- Linux另一个IPC崩溃原因仍为端口/进程并行竞态推断，串行分离后待CI验证。
- 纠正测试分类后，协调者重跑实际无浏览器套件：runtime unit210/210、
  process integration34/34、extension33/33通过；typechecks通过。
  e979d37已push PR，Linux CI待结果。
- A35fe197已合入：请求取消跟踪、pending ledger、revision fence。
  最后read-back要求覆盖所有CDP reply（不只browserRequest）、取消优先于
  programmatic抑制、旧storage写drain、权威tab.resolve核验实际分组。
- C f37b70b与D6dcde8e已集成；协调者重跑候选：runtime217unit+34
  process integration、Pi48+12工具loadcheck、extension34全部通过。
- e979d37 Linux CI一条success一条failure，B已查明是测试两个并发fetch
  到达顺序不定；先确认queue-a握手再发queue-b后，Node22目标case10次、
  整套unit218项3次通过。107d274静态worker接线和确定性测试已合入。
- d37ea7a两次Linux CI均通过，最新107d274集成尚待重跑。
- 验收脚本54c1f07已集成，尚未对真实browser API执行。
  协调者修订要求：token示例、SW restart与extension reload区分、
  fault流程资源不提前cleanup、去掉noImplicitAny=false假严格检查。
- fork签名私钥已复制到主目录ignored tmp/swarm-rebuild-artifacts，
  权限600，内容校验一致，不公开不提交，避免清理worktree丢失。
- 全新最终reviewer CodeBuddy14在review/browser-rebuild独立树，
  候选23c3ebd；Chrome仍未授权，结果最多是非浏览器验收。
- 全新CodeBuddy14最终独立验收FAIL（候选23c3ebd），报告在
  docs/exec/browser-independent-acceptance.md。真实worker+桩page探针确认
  P0副作用后not-started错误、P1成功脚本残留timer跨请求发指令；C修订中。
- reviewer其余测试重跑通过不抵消P0/P1，Chrome阶段INCOMPLETE。
- 最新静态worker接线后协调者build/smoke、unit218、integration34通过。
- D4099b03已集成，body阶段abort归一化/自deadline取消已修，输出大列表
  UTF8预算及bootstrap abort listener清理收尾中。
- 验收5f4c19f已集成，协调者严格tsc与17/17纯selfchecks、dry-run通过，
  不连接runtime/Chrome。此前“strict --noImplicitAny false”说法已纠正。
- ca96c8b的三条Linux CI全部通过，不抵消独立review的C阻塞项。
- 已构建extension/dist-acceptance，manifest0.0.126、forkID一致、端口19990。
  只构建未加载Chrome；等C blocker修复和独立复审后通知用户打开测试Chrome。
- 本地tag extension@0.0.126指向42eb198，未push tag/未发布。
- E原会话回收后，新默认CodeBuddy15只收尾产品README与legacy test-utils
  显式build:legacy；防止产品入口教用户装上游版本。
- D6595df2已集成，协调者重跑Pi57测试、typecheck和12工具load-check通过。
  read-back发现单tab巨标题/URL、多列表联合预算、emoji切分与marker计量
  仍有边界缺口，已交D补齐；同时澄清state句柄不可跨请求复用。
- E eab8301已集成；产品README不再引导安装上游，旧Chrome测试harness
  显式build:legacy。协调者修正文档中自动attach及重载needs-rebind说明。
- C f10b201已集成；永久per-facade lease与已派发动作unknown已实现。
  read-back仍发现getExistingCDPSession原始对象、CDP订阅清理与异步timer
  拒绝处理遗漏，以及worker结束前提前返回terminated；已交C针对性补齐。
- review工作树fast-forward至d607439；原未跟踪报告已以相同SHA256保全到
  tmp/review-23c3ebd/original-independent-acceptance.md，旧探针证据不覆盖。
  CodeBuddy14只重跑原outcome/timer/facade探针；不提前给最终绿灯。
- d607439代码基线协调者验证：runtime build/smoke、unit225、process
  integration34、Pi57与12工具load-check、extension34、全部typechecks
  均通过；acceptance strict tsc、17 self-checks与不联网dry-run也通过。
  这些均未启动Chrome，后续C/D提交仍须重跑对应验证。
- CodeBuddy14独立增量复验d607439：原outcome、timer/旧proxy、frames/
  elementHandle链缺陷均由真实worker runtime+桩page探针确认修复，报告
  docs/exec/browser-independent-revalidation.md。原23c3ebd FAIL不覆盖；
  CDP/终止顺序与D预算边界仍pending，Chrome仍INCOMPLETE。
- 协调者read-back验收harness发现：相对单次submit计数错等2、成功操作未用
  snapshot ref、unknown-ref前evaluate会使snapshot过期、navigate/screenshot
  尚无主流程覆盖。默认CodeBuddy16接续旧13工作树，只针对四点收尾。
  所有改动仅准备验收，不运行live Chrome。
- a063e72的两条Linux CI均通过；main仍为8cbf68b。
- C0e4867a与D2e54b87已集成，冻结产品候选a4e1669交CodeBuddy14独立
  复验CDP监听/旧lease、async timer rejection、worker exit-before-response
  与输出预算；原d607439报告及证据保全不覆盖。
- 协调者重跑a4e1669：runtime build/smoke、unit228、process integration34、
  Pi60与12工具load-check、extension34、各包typecheck均通过。
  日志：tmp/validation-a4e1669/suites.log。harness原17selfchecks仍过，
  CodeBuddy16新修订待集成后另跑strict/selfchecks/dry-run。
- C新增changeset仍用旧包名playwriter，协调者仅修正为
  @tom-cat/pi-browser-runtime；没有改公共版本号或发布。
- CodeBuddy14对a4e1669收尾复验：无浏览器PASS，Chrome INCOMPLETE。
  报告docs/exec/browser-pre-chrome-acceptance.md；worker/CDP/pool/D预算独立
  探针已核实，原FAIL报告继续保留。46e7bf2的两条Linux CI均通过。
- 准备正向ref验收时，协调者确认新的可用性缺口：worker索引用shortRef，
  上游snapshot文本只输出CSS locator，LLM无法获得相应eN。
  已明确最小兼容修订：page.snapshot沿现有value字段返回
  refs:[{ref,role,name}]，来源必须是同次snapshot的shortRef索引。
  C补返回值，harness16改读真实refs而不从CSS值猜；此改动另行短复核。
- 33e6ab2与62962da已集成到134233d；refs返回值与正向验收闭环由
  CodeBuddy14短复核通过，追加记录已入独立报告，原证据不改。
- 协调者在134233d再次验证：build/smoke、unit228、integration34、Pi60、
  extension34、12工具load-check、全部typecheck、harness strict+22selfchecks
  与无连接dry-run均通过。日志tmp/validation-134233d/suites.log。
- 测试扩展已重建，dist-acceptance版本0.0.126、ID eeklahpecooapnailfaebkjjembkjhhg、
  端口19990；尚未启动测试runtime/Chrome。19988仍为原PID68650。
- 用户明确要求避免钻牛角尖/过度设计，当前停止新增范围，只做用户配合的
  Chrome真实测试和发现的阻塞修复；未测项目不冒充通过。
- 用户已手动启动测试runtime PID2030（19990），加载隔离profile
  12h9psg4abxxa；只读capabilities与profiles检查均200/connected。
  随后明确授权CodeBuddy真实测试及按需external-agent最小修复。
- CodeBuddy17首轮真实Chrome run e93b0af2已结束：18 PASS/3 FAIL/4 SKIP。
  报告docs/exec/browser-live-acceptance.md，原始证据在acceptance工作树
  tmp/live-acceptance-768998e/，未覆盖。截图已由协调者核实为真实fixture。
- R1：extension buildInventory过滤released tombstone，导致relay list丢记录，
  后续操作报resource-not-found而非resource-released。CodeBuddy18只修完整
  inventory保留释放状态，不改内部active过滤或重新授权；需manifest0.0.127。
- H1/H2：harness五处evaluate裸表达式没有return，导致导航/填写两项假FAIL；
  idsOf优先groupId使popup beforeIds错用组ID，第二popup记账不准确。
  CodeBuddy17只修上述脚本及普通execute成功值校验，暂不重跑live。
- 真机已观察分组/隔离、截图、ref click、network、popup归组、session.release
  与cancel可用；logs及有效输入不变断言待修脚本后补验。第二profile、人工
  重启/拖出及真实Pi交互端仍未验收，不把SKIP算PASS。
- harness/fixture进程已退出，用户runtime与Chrome保留；扩展修复集成构建后
  再请用户reload，随后仅复测这些实际路径，不追无影响下载配置日志。
- H1/H2修复983bd1c已集成：5处evaluate显式return、idsOf优先tabId，
  两popup必须不同ID；增加普通page.execute返回title的成功值检查。
- R1修复3e638d1已集成：完整inventory发布released状态，不授予CDP控制；
  内部active-only列表与释放不复活语义不变。manifest0.0.127，本地tag
  extension@0.0.127已存在，未push tag/发布。
- 协调者在8b6981b重跑extension tsc+35tests、managed-relay32tests、harness
  strict+23selfchecks均通过；已构建原loaded目录extension/dist-acceptance，
  版本0.0.127、端口19990。未重载Chrome或重启用户runtime。
- 下一步请用户重载测试扩展并确认版本，再让CodeBuddy用新run复测；旧run
  及证据保留，重载后旧资源可能needs-rebind，不将其混入新run。
- 用户重载0.0.127并手动清空旧测试组后，指定profile12h9psg4abxxa继续
  connected，新epoch为epoch-mtvjt0pc-6zkqn519ak41o；再次明确授权复测。
- CodeBuddy17用全新session/run 0546d44d在候选6aeb91c真机完成：22 PASS、
  0 FAIL、4 SKIP（exit0）。H1实读DOM/echo/logs、H2两popup不同ID、R1释放
  状态可见且拒绝resource-released、普通execute值均通过。协调者读原JSON
  核验通过，不再增加测试/派agent。
- 报告docs/exec/browser-live-retest.md；原始证据在acceptance工作树
  tmp/live-retest-6aeb91c/，旧first-report与ledger均保留，不改历史结论。
- 4SKIP为第二profile、可选CDP交叉核验、人工popup目视、主动保留资源未cleanup。
  手动重启/拖出故障和真实Pi交互端另属未测范围，不冒充通过，也不自动补跑。
- 6aeb91c的两条Linux CI均成功；所有external agent已结束，无新任务。
  fixture/harness已退出，runtime2030与测试Chrome和本run资源保留。
- 本轮结论仅为单profile核心真机流程可用，停止扩展范围；PR与worktree
  收尾待用户确认，不提前merge main或关闭测试浏览器。

# 待完成门槛

- [x] 五个 owner 首轮提交及真实无浏览器验证结果。
- [x] 集成跨层接口、类型和依赖配置。
- [x] C/D审查修复提交及协调者无浏览器验证。
- [x] 验收harness误判修复与核心操作覆盖准备。
- [x] 独立全新 agent 代码审查及a4e1669无浏览器验收。
- [x] snapshot refs可见性补齐与正向验收脚本复核。
- [x] 用户配合加载测试 Chrome 扩展并授权主体真机验收。
- [x] 第一轮主体真机测试及根因分类。
- [x] R1扩展状态回报、H1/H2验收脚本修复后真机复测：22/0/4。
- [ ] 多profile/重启/拖出/真实Pi交互端列为已知未测，不自动扩大验收。
- [ ] origin draft PR -> 验收完成后就绪 -> 最终合并。
- [ ] 归档独有产物，清理所有 swarm worktree。

# 不可越过

未获用户配合前：不启动 Chrome，不调用用户 browser 工具，不动19988。
未验收完成：不合入 main，不宣称完成，不发布 npm/Chrome 商店。
