# 系统 Chrome Profile 的扩展连接

系统 Chrome 通过 extensions/profilepilot 的 Manifest V3 扩展连接独立浏览器服务，保留当前 Profile 的页面和登录状态。App 与 CLI 使用同一个服务；外部 Agent 可在 App 关闭时继续操作浏览器。独立 Profile 仍使用已有 Gateway；这不是复制 Chrome Profile 或给日常浏览器开放公共 CDP 端口。

## 安装与使用

在任务工作台设置中选择系统 Profile 并连接。已有配对自动重连；首次安装优先已配置的真实商店入口。尚未发布时，从连接页提供的固定目录执行一次 Chrome“加载已解压的扩展程序”。目录为应用数据中的 browser-tasks/native-extension/current，不随应用安装版本变化。应用启动校验修复文件，空闲开发版连接可自动升级重载。完整步骤见[安装、更新与重连](system-chrome-onboarding.md)。

默认采用完整访问，使用现有普通 HTTP(S) 标签页，也可新建页面。扩展弹窗/侧边页提供当前页面入口、任务消息、停止/交还及可选站点限制。首次核对 Profile，已有正常配对无需反复确认。iframe/Shadow DOM、下载、历史和外部直接工具以对应模块分项验收为准。

## 边界

- 本机监听仅 127.0.0.1，验证固定扩展 ID、Origin 和随机配对令牌。应用凭据由系统安全存储保护，扩展凭据在扩展私有 storage，不进入模型上下文或状态 UI。
- 一个 Profile 同时只属于一个 owner；用户停止/接管后拒绝后续输入。重连不会解除接管或恢复已结束任务。
- 默认完整访问不能绕过 Chrome 内部页、浏览器安全界面和系统对话框等平台限制。
- 系统扩展直接工具与独立 Profile 的 agent-browser/Gateway 路由仍须遵守用户偏好，不通过切换控制通道绕过占用或接管。

## 发布和验证

```sh
node scripts/test-native-install.mjs
node scripts/package-native-extension.mjs --out artifacts/native-extension-release
node scripts/verify-native-install-lifecycle.mjs --out artifacts/install-temporary
node scripts/verify-native-install-lifecycle.mjs --manual --out artifacts/install-persistent
```

ZIP 的 manifest 位于根目录，并附资源清单与 SHA256。校验通过不等于商店已发布；现有开发 key 不能保证商店分配同 ID。参见[商店材料](native-extension-store.md)及[隐私说明](native-extension-privacy.md)。

脚本使用新建空白测试 Profile 并记录实际 OS/Chrome 版本。macOS 真机、安装包解包运行和真实商店自动更新各需独立验收，不能从 Windows 结果推断通过。
