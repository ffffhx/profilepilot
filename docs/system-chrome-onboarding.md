# 系统 Chrome 安装、更新与重连

可从 App 中选择系统 Profile 并连接，也可运行 `ppilot browser connect --profile native:目录名` 获取连接页，在对应 Profile 中打开。扩展连接由独立浏览器服务维护，退出 App 不影响外部 CLI 会话。已有配对且扩展在线时直接完成；离线时继续自动重连，不把尚未收到连接当作需要重新申请调试许可。

## 持久安装

正式渠道优先 Chrome Web Store。只有 PROFILEPILOT_EXTENSION_STORE_URL 配置为官方地址、路径末尾 ID 与应用一致时，连接页才显示商店入口。未配置时明确显示尚未上架商店，不编造商店链接。

发布前的本地使用步骤：

1. 点击“打开扩展管理页”，开启 Chrome 开发者模式。
2. 点击“加载未打包的扩展程序”，选择连接页提供的固定目录；目录旁提供“复制目录”按钮。
3. 返回连接页，点击“已安装，连接”。首次核对 Profile 并连接；后续保留配对并自动重连。

固定目录为应用数据目录下 browser-tasks/native-extension/current。不要选择源码目录、app.asar 内部或带版本号的应用安装目录。Windows 资源来自 resources/profilepilot-extension，macOS 来自 .app/Contents/Resources/profilepilot-extension，均通过现有 extraResources 打包后复制至固定目录。

手动加载与 CDP 会话加载不同。实际持久性必须用下方真实脚本验收；不能用 --load-extension、改 Preferences 或伪造安装标志充当手动安装验证。[Chrome 的加载与重载说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)

## 升级与修复

浏览器服务启动时校验 manifest 的 MV3/key/ID，递归检查资源（含侧边栏和图标），修复缺失、损坏或旧文件。更新先完整写入 staging，再替换 current；替换失败回滚。旧 hash 目录保留，避免破坏曾经从旧目录加载的安装；这种安装需一次重新选择 current。

维护器只自动重载 installationType=development、未标为 temporary 且版本较旧的扩展。须已连接、没有 owner 且未被浏览器暂停；接管中的任务仍有 owner。扩展执行请求时再次检查 owner。每个 Profile/旧版本/目标版本组合最多尝试一次。20 秒未报告目标版本或调用失败，会显示可修复失败状态，提示手动重载/重新选择固定目录，不循环重载；停止浏览器服务才会取消监听与等待定时器。

商店版由 Chrome 更新；新于应用的扩展不降级。开发修改应提升 manifest version，同版本文件修复后可手动重载。同 ID 的重载保留扩展私有 storage，不需要卸载扩展或清除配对。

## 临时自动安装

折叠的临时安装入口需 Chrome 149+、浏览器远程调试开关和 Chrome 连接许可。安装器读取正确 Chrome 用户数据目录的 DevToolsActivePort，校验邀请页、chrome://version 的实际 Profile 路径、扩展 ID 和启用状态，只刷新邀请页，随后关闭检查页并断开安装 CDP。

该协议没有持久安装参数。Chrome 153 会清理 CDP 会话安装，不能称其永久有效；各版本行为以实际验收报告为准。应用不改写 Chrome 安装标志。[CDP Extensions 协议](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)

Windows Chrome 153.0.8010.53 实验还发现临时安装调用 runtime.reload 后会被禁用。安装器因此在扩展私有 storage 写入 profilepilotInstallation.mode=temporary；扩展上报 installationMode，维护器跳过热更，extension.reload 直接返回修复提示，不执行导致禁用的调用。临时版升级需显式重新安装。用户确实改为持久安装后，可在扩展界面明确确认以清除临时标记；系统不根据等待时间或“打开过扩展页”猜测安装已完成。

## 凭据与状态

连接票据五分钟有效。凭据只通过校验 Host、扩展 Origin 的一次性端点交给扩展，不写入 HTML/URL/状态 JSON。页面操作要求同源 POST 与自定义请求头。取消会阻止晚到准备结果再打开 Chrome。只有真实扩展连接才报告 connected，文件准备完成不等于已安装。

InstallProgress 保持原 stage，新增可选 mode(local/store/temporary)、extensionPath、version。临时连接成功仍显示重启限制。

## 验收

无需写共享 dist：

```sh
node scripts/test-native-install.mjs
node scripts/package-native-extension.mjs --check
node scripts/verify-native-install-lifecycle.mjs --out artifacts/install-temporary
node scripts/verify-native-install-lifecycle.mjs --manual --out artifacts/install-persistent
```

最后一个命令在 Windows/macOS 都可运行：编译当前源码到独占临时目录，启动全新空白 Chrome，打印固定扩展路径。在这个测试 Chrome 中执行一次真正的“加载已解压的扩展程序”；其后自动验证首次配对、应用重启、扩展重载保留凭据、固定目录版本升级和自动重载、Chrome 重启保留安装与配对。十分钟未完成手动加载则失败退出。不触碰日常 Profile。

result.json 记录 OS/架构/Chrome 版本/资源 digest/实际检查结果。macOS 必须在真机运行两种模式，核对 Apple Silicon/Intel、含空格和中文路径、应用移动升级、Chrome 重启、商店与本地加载、组织策略；Windows/mock 不代表 macOS 通过。真实商店安装、自动更新、审核与发布另需有效发布者账号和真实 item，见[商店材料](native-extension-store.md)。
