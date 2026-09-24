# 系统 Chrome 授权连接

设置 → 连接系统 Chrome → 选择 Profile → 授权并连接。

应用使用现有跨平台 Chrome 启动器指定 `--profile-directory` 打开本机连接页。已有扩展会直接打开标签页授权页；首次安装会自动准备应用自带的扩展文件，并在用户开启 Chrome 远程调试、确认浏览器连接请求后，通过浏览器级 CDP 安装扩展。连接页仅监听 127.0.0.1。用户选择普通网页标签页并授权后，应用通过实际扩展连接状态确认成功。

连接票据五分钟有效。配对凭据仅通过校验 Host 和扩展 Origin 的一次性端点交给扩展，不写入连接页、URL 或任务记录。扩展授权页关闭不会自动控制浏览器，任务执行仍由用户在应用中发起。过期后从应用重新授权。

## 首次自动安装

需要 Chrome 149 或更新版本。用户首次在 `chrome://inspect/#remote-debugging` 开启远程调试，并确认 Chrome 原生连接弹窗。这两个浏览器授权动作不能由未连接的 CDP 自行完成。无需从商店下载、选择文件夹、复制配对码或重启 Chrome。

**会话安装限制：** Chrome 153 会在浏览器重启时移除通过 CDP 安装的扩展（[Chromium 的扩展首选项实现](https://github.com/chromium/chromium/blob/153.0.8010.50/extensions/browser/extension_prefs.cc)）。因此不能将此路径宣传为永久安装。重启 Chrome 后点击“授权并连接”，应用自动检测缺失、再次请求 Chrome 连接许可并补装；随后重新选择标签页。正式商店发布后，可使用商店安装路径保留扩展。应用不会修改 Chrome 的扩展标志或用户数据来规避清理。

安装器校验内置 manifest key 对应的扩展 ID，将完整扩展复制至应用数据目录 `browser-tasks/native-extension/<内容哈希>`，避免 asar 或应用更新导致路径失效。Windows 与 macOS 均从实际 Chrome 用户数据目录读取 `DevToolsActivePort`，不扫描端口，也不修改 Chrome Preferences 或启动参数。

获得连接许可后，检查 Chrome 版本、当前连接页和 `chrome://version` 的 Profile 路径。匹配所选 Profile 后调用 `Extensions.loadUnpacked`，校验返回 ID 和启用状态，只刷新本次连接页，关闭验收用的版本页并断开安装 CDP。后续任务由扩展承担，不保留安装器控制通道。

页面会显示准备、等待开启调试、等待浏览器确认、安装和标签页授权的实际状态。取消、拒绝授权、关闭浏览器、过期或安装失败不会静默反复请求权限；用户可重试。浏览器过旧或组织策略阻止安装时，页面说明原因，应用设置中保留“手动安装与配对”入口。

## 商店发布

上传 extensions/profilepilot 的内容，manifest.json 必须位于压缩包根目录。当前扩展 ID 为 gmdaabnoocjlpimglalnbegfdaklfnaj；发布时须确保商店 ID 与 manifest key 和后端 ID 一致。商店审核、隐私披露和发布需要发布者账号完成。

发布后为应用进程配置 PROFILEPILOT_EXTENSION_STORE_URL，值为真实的 https://chromewebstore.google.com/detail/<可选名称>/gmdaabnoocjlpimglalnbegfdaklfnaj。连接页只接受此官方域名且 ID 一致的地址；未配置时安装应用自带版本，不生成假商店地址。

连接页每秒读取不含凭据的安装状态。安装完成后自动刷新连接页，扩展通过一次性端点获取配对请求，跳转自身授权页。网页操作端点校验 Host、Origin、自定义请求头和 POST 方法；普通页面无法读取配对凭据。

Windows/macOS 共用配对协议与扩展页面；Chrome 的定位和 Profile 启动沿用各平台现有实现。单元测试使用临时目录和可控 CDP 响应，界面测试使用独立 Electron 测试窗口。用户明确授权的真实验收才会在指定日常 Profile 安装扩展；验收结果须区分自动测试与实际浏览器测试。
