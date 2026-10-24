# 扩展浮层与浏览器控制

Chrome 的 debugger API 可能因网页中嵌入其他扩展的 iframe 而拒绝连接，或在输入触发密码管理器浮层时断开。0.2.12 增加了当前任务页面的临时兼容处理。

## 处理范围

- 固定的隔离世界脚本在普通 HTTP/HTTPS 页面加载，但只有当前任务明确授权的顶层文档能取得有效许可。其他标签页、隐身页面、被站点设置禁止的页面、用户接管期间均不处理。
- 仅临时移开 `chrome-extension://`（包括包裹该来源的 blob/filesystem URL）的外部 iframe。普通网站 iframe、ProfilePilot 自己的 iframe 和扩展内部文档不读取、不修改。
- 支持嵌套的 open/closed Shadow DOM 和动态插入，扫描跳过不适用 HTMLElement API 的 SVG/MathML 节点；操作前再次扫描晚创建的 Shadow DOM。移开的节点用注释占位；交还、停止、切换标签、断开连接或任务结束时恢复。原宿主已被网页删除时不会重建宿主；恢复 iframe 会重新加载其内部页面。
- 许可每 3 秒复核，12 秒失联过期，文档离开时也恢复。不会全局停用密码管理器、改动密码库或改变 Chrome 的安全设置。

## 中断与恢复

已移开浮层但 Chrome 先发出技术断开事件时，只有同一任务仍拥有同一标签页、没有用户停止、并且脚本确认在本次连接后移开过冲突 frame，才自动重连一次。其他扩展占用调试器、未知原因断开或未消除的冲突仍会报告失败。

初次连接也可能遇到 DOM 节点已移除、Chrome 尚未完成 frame 释放的延迟。仅在近期确实移开过冲突 frame 时，等待 100 毫秒重试一次连接；此时尚未发送网页动作。

重连不会重放 CDP 操作。进行中的命令若受影响，返回 `NATIVE_DEBUGGER_RECOVERED`，结果按“未知”处理：读取新观察，检查上一步是否已生效，再决定后续操作。旧的 frame/context/ref 缓存失效。用户接管或取消始终优先，技术恢复不能重新取得已交还的控制权。

## 验证

`node --test tests/native-frame-guard.test.js tests/native-debugger-failures.test.js tests/native-control-generations.test.js`

`node scripts/verify-native-debugger-failures.mjs` 在临时 QA Profile 中加载本地无权限测试扩展，验证已有 iframe、输入后动态 closed-shadow iframe、恢复和交还、普通 iframe 保留以及输入只执行一次。此脚本不使用真实密码管理器数据，也不操作日常 Profile。

代码使用 Chrome 扩展 API，不依赖 Windows/macOS 的窗口快捷键。跨平台单元测试不能代表 macOS 真机验收；需分别记录实际浏览器验证结果。

2026-10-23 在 Windows 上完成构建、141 项相关回归测试及上述真实 Chrome QA 测试。默认 Chrome 中实际安装的 0.2.12 也已在启用 1Password 的 Google 身份验证页面成功连接并读取，无需手动关闭浮层；CLI、浏览器服务与扩展版本检查一致。Google 通行密钥验证仍需用户完成，未提交邮箱变更。macOS 尚未进行真机验证。
