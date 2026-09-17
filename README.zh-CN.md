# Pi Browser Use

[English](./README.md) | 简体中文

Pi Browser Use 让 Pi agent 直接操作用户真实浏览器里已经打开的标签、Cookie 与登录态，
一切通过 `browser_*` 工具完成。Chrome 走 `chrome.debugger` 扩展；Firefox 139+ 与 Zen
使用普通 WebExtension 加 DOM 后端，不需要远程调试，也不需要特殊启动参数。两者都连接
本机 `127.0.0.1:19989` 上的 managed runtime（数据目录 `~/.pi-browser-use`），浏览器
始终留在本地，没有云端浏览器。

安装包是 [GitHub Releases](https://github.com/tom-cat-mao/pi-browseruse-playwriter/releases)
上的带版本号产物：推送 `extension@<version>` tag 即自动发版。请使用这些产物，不要用
GitHub 自动生成的源码压缩包。

## 安装 Chrome 扩展

Chrome 尚未上架 Web Store（listing 待上架），需要手动加载一次：

1. 从 Release 下载 `pi-browser-use-extension-<version>.zip`。
2. 解压到一个以后不会移动的固定目录，例如
   `~/Applications/pi-browser-use-extension`。扩展安装后不要移动或删除该目录。
3. 打开 `chrome://extensions`，开启 **开发者模式**，点击 **加载已解压的扩展程序**，
   选择包含 `manifest.json` 的目录。

开发构建的扩展 ID 是 `eeklahpecooapnailfaebkjjembkjhhg`，扩展选项页内置一个本地入门
指南。

## 安装 Firefox / Zen 扩展

Firefox 139+ 与 Zen 可以安装 Mozilla 已签名的
`pi-browser-use-firefox-extension-<version>.xpi`，它来自 AMO unlisted（自分发）渠道，
可永久安装：

1. 从 Release 下载 `pi-browser-use-firefox-extension-<version>.xpi`。
2. 打开 `about:addons`，点击齿轮图标，选择 **从文件安装附加组件…**，选中该 XPI。

`-unsigned.xpi` 与 Firefox ZIP 是开发产物，只能在
`about:debugging#/runtime/this-firefox` 通过 **临时加载附加组件** 使用，Firefox 重启后
即消失。页面动态 JavaScript 需要 Firefox 153+ 并在扩展弹窗中授予可选权限；只做 DOM
操作则不需要。能力与边界见 [Firefox 指南](./docs/exec/firefox-extension-guide.md)。

## 安装 Pi 侧

浏览器安装包不会安装 Pi 包与 runtime，两者需要单独安装。在源码检出目录（要求
Node >= 20、pnpm `10.18.1`、Bun）执行：

```bash
pnpm bootstrap
pnpm --filter @tom-cat/pi-browser-runtime build
pi install ./pi
```

目前没有 npm 发布，Pi 包直接从这个检出目录安装。runtime 不需要手动守护：Pi 在首次
调用工具时自动拉起，`/browser-status` 可查看连通性、能力与已连接的 profile。

## 能力概览

- 用显式 `tabId` 读写真实标签：可访问性快照、点击、填表、evaluate、截图、控制台日志
  与网络抓包。
- 用 `browser_tabs discover` + `attach` 原地接管用户已打开的标签：不刷新、不搬窗口、
  保留滚动位置与表单内容；完成后用 `release` 放手。
- `browser_extract` 把整页导出为 Markdown / text / HTML，可把完整内容写入 runtime 的
  artifacts 目录，也能把页面图片下载到该目录。
- 多 profile、多具名 group 相互隔离：一个 session 可并行处理多个浏览器身份，每个
  group 固定绑定一个 profile。

## 文档

| 文档                                                       | 内容                                        |
| ---------------------------------------------------------- | ------------------------------------------- |
| [Firefox 指南](./docs/exec/firefox-extension-guide.md)     | DOM 后端能力、边界以及与 Chrome 的差异      |
| [扩展发行清单](./docs/exec/extension-distribution-plan.md) | Release 产物、AMO 签名与 Web Store 上架准备 |
| [模型侧用法](./pi/skills/SKILL.md)                         | agent 应如何使用这些工具                    |
| [AGENTS.md](./AGENTS.md)                                   | 仓库结构、命令与协作规则                    |
| [README.md](./README.md)                                   | 本页的英文原版                              |

## 许可与上游

Pi Browser Use 是 [remorses/playwriter](https://github.com/remorses/playwriter) 的维护
fork，保留上游的 [MIT 许可](./LICENSE) 与署名。
