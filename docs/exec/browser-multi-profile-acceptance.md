---
title: Pi Browser Use 双 profile 专项验收报告（候选 99eb7ae）
description: >-
  两个真实 Chrome profile 的专项真机验收：同一新 session 在
  P1/P2 各建同名组和 tab，验证 profile 过滤、快照操作互不串页与
  document.cookie 隔离；3/3 PASS，资源保留。
prompt: |
  来源：用户授权多 profile 专项指令（本次会话原文，节选）：
  "用户已新建第二个测试Chrome profile并明确授权……只测多profile……
  需要真测的三点：1) 一个全新session UUID在P1/P2各建一个同名组和一个
  tab……groups.list profile过滤准确、两个group/profile绑定正确。
  2) 分别填不同值、snapshot-ref点击Submit（eval读取必须return），
  交替读回marker+input+echo证明互不串页；fixture计数各恰一次……
  3) 相同origin、相同仅本run随机cookie名，在P1写A，P2应没有该cookie；
  P2写B后P1仍A、P2B……测试后仅清掉本run cookie即可……
  复用现有acceptance-client.ts/startFixtureServer/snapshot-refs.ts，
  一个小的专项脚本放ignored tmp/multi-profile-99eb7ae/……
  每profile只创建1组1tab(2+2总计)，保持新tab供用户看，写ledger含真实
  session/group/tab/profile，保留resources不cleanup……
  结果新写docs/exec/browser-multi-profile-acceptance.md，
  frontmatter含candidate99eb7ae/source/run，简单3点PASS/FAIL和证据路径"
  candidate: 99eb7ae（扩展 0.0.127）
  run: 7a2051ce，session a34f7fcc-652e-44e9-ab88-05827e1685a3
  P1=12h9psg4abxxa（epoch-mtvjt0pc-6zkqn519ak41o）
  P2=1sr6lelstfua1（epoch-mtvk3jt4-1fas0qs1u9urzd）
  脚本：@tmp/multi-profile-99eb7ae/multi-profile-acceptance.ts
  复用：@playwriter/scripts/acceptance/acceptance-client.ts
  @playwriter/scripts/acceptance/fixture-server.ts
  @playwriter/scripts/acceptance/snapshot-refs.ts
---

# 结果

3 点全部 PASS（最终一轮 stdout-resume-2.log，exit 0）。

1. **PASS multi-profile-groups-tabs**：同一新 session 在 P1/P2 各建一个
   同名组 `mp-<runId>-shared` 与一个 tab，均指向同一 fixture origin。
   groups.list 按 profile 过滤：P1/P2 各自恰好返回自己的那个组，组
   profileId 绑定正确；无 profileId 时恰好返回两个新组。
   groups `pgrp-mtvk8wbw-eirehya1jwp7`(P1)/
   `pgrp-mtvk8wc0-obeh8j1du1g6k`(P2)；tabs
   `ptab-mtvk8wc3-92y38q1mdrqji`(P1)/
   `ptab-mtvk8wgl-3k50fs1ycg99r`(P2)。
2. **PASS multi-profile-no-cross-talk**：分别 fill
   `mp-value-P1-7a2051ce`/`mp-value-P2-7a2051ce`（aria-ref+snapshotId），
   Submit 点击用新 snapshotId；交替读回 marker+input+echo（evaluate 均带
   return）始终各归各自 tab；fixture 计数各恰一次（delta=1）。
3. **PASS multi-profile-cookie-isolation**：同 origin 同 run cookie
   `mpc-7a2051ce`：P1 写 A 后 P2 读为空；P2 写 B 后 P1 仍 A、P2 为 B；
   两 profile 均已清除该 cookie（只读写这一个自造 cookie）。

# 过程说明（脚本侧，非产品问题）

- 首轮尝试在 check2 收到 HTTP 400：脚本从错误字段取 snapshotId
  （应在 `data.snapshotId`，不在 `data.value`），发出了空 snapshotId。
  一次最小复现：`repro-empty-snapshotid-400.json`
  （`HTTP 400 {"error":"\"snapshotId\" must not be empty"}`）——产品校验
  行为正确。脚本已修正并加空值保护。
- 第二次尝试 resume 时 requestId 与首轮形状相同，被 relay 去重拒绝
  （`requestId ... was already used with a different request payload`）
  ——relay 行为符合契约。脚本已加 per-process nonce。
- 修正后 resume 复用同一 run/session/组/tab（不新建第二套资源），把
  复用 tab 导航到新 fixture origin 后完成 check2/3。

# 证据与本轮资源

- 最终报告/ledger：tmp/multi-profile-99eb7ae/
  report-7a2051ce-resume-20260910132727.json、
  ledger-7a2051ce-resume-20260910132727.json；
  过程证据：stdout.log、stdout-resume.log、stdout-resume-2.log、
  repro-empty-snapshotid-400.json。
- 资源保留供查看（不 cleanup）：1 session、2 groups、2 tabs
  （每 profile 各 1 组 1 tab，state ready）。
- fixture 已随脚本 try/finally 关闭，端口无 LISTEN 残留，无脚本/后台
  进程；runtime（PID 2030）与两个 Chrome profile 保留。

# 未测

9333 交叉校验、popup 手工目视、故障 phases、登录类站点 cookie 行为
（本轮只用自造 cookie 证明 profile 独立），均未在本授权范围内。
