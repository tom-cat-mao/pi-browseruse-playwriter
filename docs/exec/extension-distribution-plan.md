---
title: Extension distribution plan
description: Maintainer checklist for GitHub Releases and Chrome Web Store preparation.
prompt: |
  用户要求实现简化的 Pi Browser Use 扩展发行层：GitHub Releases 手动安装
  ZIP、Chrome Web Store 上传准备和 README 安装说明；不改浏览器功能，不自动
  发布；真实商店 ID 未知时只记录待接入。参考 @README.md
  @extension/manifest.json @extension/permissions.md
  @scripts/package-extension.mjs @.github/workflows/extension-release.yml
  以及 Chrome Web Store prepare/publish/key 官方文档。
  用户追加要求：
  我觉得pr可以合，但是我还有一个问题，能不能每一次打tag的时候自动生成到releas中呢
  这个应该不难做到吧
---

# Extension distribution plan

当前状态：推送 extension@<version> tag 自动构建、签名并发布 GitHub Release，附件含
Chrome 与 Firefox 两套产物，其中 Firefox XPI 由 AMO unlisted 渠道自动签名；手动触发仍
默认创建 Draft。Chrome Web Store 仍是“上传准备包”，尚未提交或上架。

## GitHub Releases

1. 提交 `extension/manifest.json` 的新版本，并确保目标提交包含发行 workflow。
2. 创建与 manifest 版本一致的 tag，推送到 origin，例如新版本为 0.0.131 时：

   ```bash
   git tag extension@0.0.131
   git push origin extension@0.0.131
   ```

3. `.github/workflows/extension-release.yml` 自动检出该 tag、构建、打包、用 AMO
   签名并校验产物，发布同名 Release，附 Chrome ZIP、Firefox ZIP、未签名 XPI、
   AMO 已签名 XPI 及各自 `.sha256`：
   `pi-browser-use-extension-<版本>.zip`（Chrome）、
   `pi-browser-use-firefox-extension-<版本>.zip`、
   `pi-browser-use-firefox-extension-<版本>-unsigned.xpi` 与
   `pi-browser-use-firefox-extension-<版本>.xpi`。带 `-unsigned` 的两个是开发产物
   （Firefox 139+，只能 `about:debugging` 临时加载）；无后缀的 `.xpi` 是 AMO
   unlisted 渠道的签名产物，可在正式版 Firefox/Zen 永久安装。不触发 Chrome 商店或
   npm 发布。该 workflow 依次跑 `pnpm package:extension`（Chrome）、
   `pnpm package:firefox`（Firefox）与 `pnpm sign:firefox`（签名）；打包只处理
   runtime 构建产出的 bundle，缺失时直接报错，不静默跳过。
4. `extension@0.0.138` 与 `extension@0.0.140` 上 Firefox ZIP 与未签名 XPI 是自动
   发布后手工补传的，附件名与内容同 workflow 现在产出的完全一致；本改动之后无需
   再手工补传。这两个 tag 的 XPI 早于签名接入，已发布的 tag 不会补跑，因此它们的
   附件里没有已签名 `.xpi`。
5. 本地仅创建 tag 不触发；其他前缀的 tag 不触发；现有 tag 不会因 workflow
   合并而补跑。版本或 tag 所指提交不匹配时停止，避免打包错版本。
6. Actions 重跑会更新该 Release 的同名附件（Chrome、Firefox 与签名产物都覆盖），
   不重复创建 Release；同 tag 串行执行。手工 dispatch 填写 ref/tag 时仍默认
   Draft，便于提前检查。

本地验证命令为 `pnpm --filter @tom-cat/pi-browser-runtime build` 后
`pnpm package:extension`、`pnpm package:firefox` 与 `pnpm sign:firefox --dry-run`，
产物位于 `dist-release/`。

## AMO unlisted 签名

Firefox 侧用 [web-ext](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign)
的提交 API（`web-ext/util/submit-addon`，即 `web-ext sign` 命令的底层实现，因此可以直接
提交已打包的 XPI）走 AMO unlisted（self-distributed）渠道签名，manifest 里的稳定身份是
`pi-browser-use@tom-cat-mao.github.io`，`strict_min_version` 为 139.0。

1. 在 addons.mozilla.org 生成 API key，把 JWT issuer 与 secret 存进仓库
   secrets：`AMO_JWT_ISSUER`、`AMO_JWT_SECRET`。签名步骤通过 env 注入这两个值；
   本地等价命令是 `AMO_JWT_ISSUER=... AMO_JWT_SECRET=... pnpm sign:firefox`，两者
   缺一即报错退出，不会静默跳过签名。
2. `scripts/sign-firefox-extension.mjs` 上传的是 `pnpm package:firefox` 产出的
   `pi-browser-use-firefox-extension-<版本>-unsigned.xpi` 本身，因此提交给 AMO 的
   字节与发布出去的 ZIP/XPI 完全一致（脚本会打印上传文件的 sha256）；AMO 返回的
   签名文件落到 `dist-release/pi-browser-use-firefox-extension-<版本>.xpi` 并附
   `.sha256`，校验其带 `META-INF/mozilla.rsa` 后才算成功。
3. 同一版本号在 AMO 只能提交一次，所以脚本先查
   `GET /api/v5/addons/addon/<gecko id>/versions/<版本>/`：该版本已签名时直接下载
   AMO 上已有的签名（重跑同一 tag 仍然产出一致的附件），已存在但尚未签名时明确
   报错提示稍后重跑。其它签名失败原因（凭证错误、校验或审核拒绝、网络错误）都会
   让 workflow 失败，不吞错。
4. 检查签名接线而不接触 AMO 的命令是 `pnpm sign:firefox --dry-run`：它校验 bundle、
   已打包 XPI 与凭证是否存在，并打印将要发出的 AMO 请求后退出，不发任何网络请求。
5. `-unsigned.xpi` 与 Firefox ZIP 继续作为开发产物发布；只有无 `-unsigned` 后缀的
   `.xpi` 是 AMO 已签名、可永久安装的产物。未列出的商店渠道（AMO listed）不在本轮
   范围内。

ZIP 必须把 `manifest.json` 放在根目录；扩展运行时 JavaScript、页面、样式与图标
全部随 ZIP 提供，不依赖远程脚本或 CDN。

## Chrome Web Store checklist

- 准备 Chrome Web Store developer account，并在 dashboard 新建 item。
- 准备单一用途说明：把用户当前 Chrome 标签通过本机 CDP 连接到 Pi
  Browser Use 的本地 runtime，用于浏览器自动化。
- 按 `extension/permissions.md` 准备每项权限理由；本轮不扩大权限。
- 准备隐私政策页面、商店图标/截图、简短 listing 文案和审核测试说明。
- 上传 manifest 根目录的 ZIP，填写 listing、privacy 和 distribution 信息，
  选择需要的发布方式；可使用 deferred publish，然后按审核流程
  `Submit for review`。
- 通过审核后才在 README 增加真实商店入口；在此之前不要写一键安装链接。

官方流程：[准备扩展](https://developer.chrome.com/docs/webstore/prepare)、
[发布扩展](https://developer.chrome.com/docs/webstore/publish)、
[manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)。

## Store identity handoff

开发 ZIP 的 `manifest.key` 只维持 fork 开发 ID
`eeklahpecooapnailfaebkjjembkjhhg`，不冒充上游商店 ID。首次 dashboard 上传
后，以 dashboard 给出的真实 item ID 和 **View public key** 为准；拿到这两项
后再一次性接入 manifest key 和 runtime 的严格 extension-origin allowlist，
并确认二者匹配。未拿到真实 ID 前，本轮不修改 allowlist，也不声称商店版已
上架。
