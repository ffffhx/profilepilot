# 网页中的扩展界面操作

ProfilePilot 扩展 0.2.13 与浏览器服务新增 `extension-ui` 模式。它用于已授权网页中嵌入的扩展浮层，例如密码管理器的登录选项。浏览器服务通过 CDP 连接同一个 Chrome，ProfilePilot 扩展保留原任务的所有权并提供精确的 tabId → targetId 映射；不用桌面鼠标、键盘或屏幕识别。

## 使用

先在正确的 Profile claim 标签页，再用同一个 session：

```sh
ppilot browser --session TASK extension-ui connect --params-file extension.json
ppilot browser --session TASK extension-ui status
ppilot browser --session TASK extension-ui observe
ppilot browser --session TASK extension-ui click --params-file button.json
ppilot browser --session TASK extension-ui disconnect
ppilot browser --session TASK observe
```

`extension.json` 为 `{"extensionId":"实际目标扩展的32位ID"}`；`button.json` 为观察返回的 `{"version":"...","ref":"x1"}`。连接期间扩展弹窗显示“扩展界面模式”。

Chrome 须在 `chrome://inspect/#remote-debugging` 启用远程调试。`connect` 立即返回 `authorizing`，等待 Chrome 原生连接授权最多 180 秒，期间可查询状态或停止。点击允许后状态变为 `ready`。连接由独立服务保留，连续 CLI 命令复用连接。Chrome 要求每个新连接获得用户允许，工具不能省略这一步。[Chrome 官方说明](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)

## 范围与生命周期

- 同一任务不能同时运行普通网页调试与扩展界面调试。进入时解除扩展 debugger、恢复临时移开的浮层；退出后再按普通观察流程连接。
- 只读取所选扩展在授权标签页内的按钮、链接和选项标签，不返回密码输入框值，不开放任意脚本、扩展 service worker 或工具栏 popup 操作。
- 跨进程 iframe 根据 Chrome 返回的父子关系确定归属；同 URL 的其他标签页浮层不会被选中。同进程 frame 使用独立执行上下文。
- 点击绑定观察版本、文档 loaderId、frame、原 DOM 元素和按钮标签。执行后旧版本失效；相同 requestId 只返回原结果，不重放点击。点击成功不等于登录成功，须核查界面结果。
- 用户接管、结束、释放、扩展断线、页面目标改变或 CDP 断线后停止操作。失联许可 12 秒过期，不自动重连、不自动 resume；新建连接必须显式请求。
- 无法代替密码库解锁、系统生物识别或通行密钥确认。是否能完成特定 1Password 登录必须实测，不能由测试扩展结果推断。

## 验证记录

2026-10-23 Windows：构建和相关自动化测试通过。`node scripts/verify-native-extension-ui.mjs` 使用独立临时 Chrome Profile 和本地测试扩展，实际验证浮层读取、点击一次、重复 requestId 不重放、密码值不返回、接管关闭及普通网页控制恢复。macOS 尚未真机验证。

核心实现：`src/main/native-control/extension-ui.ts`；协议与权限测试：`tests/native-extension-ui.test.js`。运行测试不读取真实密码库。

同日已将 0.2.13 安装到本机默认 Chrome，doctor 确认 CLI、独立浏览器服务和扩展版本一致，服务在启动命令结束后继续运行。真实 1Password 测试已发起 Chrome 连接请求，但等待超时，随后关闭通道并交还控制；真实 1Password 的按钮读取、点击及登录效果尚未验收。未提交 Google 邮箱变更。
