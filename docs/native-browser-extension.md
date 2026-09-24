# 系统 Chrome Profile 的扩展连接

ProfilePilot Agent 支持两条独立连接：独立 Profile 使用已有 Gateway；系统 Chrome Profile 使用 `extensions/profilepilot` 中的 Manifest V3 扩展。任务审批、提交去重、人工接管、资料范围和模型设置复用现有任务服务。

## 安装与使用

1. 打开 ProfilePilot 的任务工作台 → 设置 → 连接系统 Chrome，选择 Profile 后点击“授权并连接”。
2. 首次按连接页提示开启 Chrome 远程调试并确认浏览器弹窗。Chrome 149+ 会自动安装应用自带的扩展；Windows 和 macOS 安装包均携带完整扩展目录。详见[授权与自动安装流程](system-chrome-onboarding.md)。
3. 扩展自动打开授权页，不必复制配对码。核对当前 Profile，选择允许操作的起始标签页并连接。
4. 回到任务工作台，选择带“系统 Chrome 扩展”标记的浏览器执行任务。

首次自动安装通过 Chrome 的用户授权调试通道核对 Profile 路径；扩展配对时仍显示 Profile 名供用户确认。不会读取或复制 Cookie，也不会用启动参数强制开启默认用户数据目录的调试端口。安装后立即断开安装器的 CDP 连接。

后续应用重启会恢复配对；任务不会因为连接恢复而自动重新取得控制权。Chrome 153 会在浏览器重启时清理 CDP 安装的本地扩展，需要再次点击“授权并连接”自动补装，并重新选择授权标签页。手动加载或商店安装的扩展不经过此 CDP 清理路径，但重启后同样需重新选择标签页，避免复用失效的编号。也可以先“我来操作”，再更换授权标签页，然后交还任务。

当前使用应用自带的本地扩展，尚未发布到 Chrome 网上应用店。设置保留手动加载扩展文件夹与手动配对入口，用于不支持自动安装的浏览器。

## 实现与边界

- 扩展使用 Chrome 官方 `chrome.debugger` 传输 CDP，任务侧使用 `NativeBrowser` 适配器。现有 DOM 观察、元素引用及页面变更校验由 `FastBrowser` 复用。
- 本机连接只监听 `127.0.0.1`，验证扩展 Origin、固定扩展 ID 和随机配对令牌。令牌在 Electron 端由系统安全存储加密；不进入任务 JSON、模型上下文或诊断导出。扩展端使用 Chrome 扩展私有存储。
- 每个 Profile 同时只属于一个任务；接管期间保留归属并拒绝输入。扩展断线、关闭目标标签页、用户停止调试都会阻止后续操作。不会接管其他扩展占用的 debugger 会话。
- 起始标签页由用户选择，任务只能切换到授权标签页及任务从这些页面打开的子页面。普通任务不能枚举整个 Profile 的未授权标签页。
- 实时画面走 `Page.startScreencast`，不轮询截图，也不写入任务记录；最大 10 帧/秒，渲染端确认后发送下一帧。预览使用焦点模拟保持后台标签页出帧，不抢占操作系统焦点，但页面会暂时感知为可见/聚焦；停止预览或调试时恢复。
- 支持主文档观察、按需截图、导航、点击、表单输入、下拉选择、复选框、按键、滚动、授权标签页切换和任务附件上传。
- 当前跨域 iframe、浏览器内部页、系统对话框和下载文件落盘确认需要用户接管。下载仍可由 Chrome 正常完成，但 Agent 不自动读取用户的下载目录。
- 原有 `agent-browser --cdp` / Gateway CLI 仍只用于独立 Profile；这个扩展入口用于应用内的 ProfilePilot Agent，不把系统 Profile 暴露成公共 CDP 端口。

## 参考与验证

独立实现，未复制 ChatGPT Chrome 私有运行时，也不依赖 ChatGPT 宿主。参考公开文档和架构：

- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome 默认用户数据目录的远程调试限制](https://developer.chrome.com/blog/remote-debugging-port)
- [Microsoft Playwright 扩展](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)（Apache-2.0；仅作为架构参考，无源码拷贝）

验证命令：

```sh
npm run build
node --test tests/native-browser.test.js
node scripts/e2e-native-browser.mjs
node scripts/verify-native-browser.mjs
```

最后一个脚本通过 ProfilePilot Gateway 创建临时测试 Profile、加载扩展并释放初始化连接，再用扩展执行本机表单操作和实时预览验证。不会触碰日常 Chrome 的页面或登录态。Windows Chrome 153 已实测；macOS 使用同一扩展和 Electron 安全存储接口，尚未在 macOS 真机验收。
