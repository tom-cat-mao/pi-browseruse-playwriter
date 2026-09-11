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
---

# Extension distribution plan

当前状态：GitHub Releases 由维护者手动触发 Draft release；Chrome Web Store
仍是“上传准备包”，尚未创建、提交或发布 item。

## GitHub Releases

1. 在目标 feature/tag 上确认 `extension/manifest.json` 版本递增。
2. 运行 `pnpm --filter @tom-cat/pi-browser-runtime build` 生成本地 runtime
   bundle，再运行 `pnpm package:extension`。
3. 检查 `dist-release/` 中的版本 ZIP 和 `.sha256` 文件。
4. 手工 dispatch `.github/workflows/extension-release.yml`，同时填写准确的
   `ref` 和 `extension@<version>` tag。workflow 只创建 Draft release，不会
   自动发布。

ZIP 必须把 `manifest.json` 放在根目录；扩展运行时 JavaScript、图标和 Prism
资源全部随 ZIP 提供，不依赖远程脚本。

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
