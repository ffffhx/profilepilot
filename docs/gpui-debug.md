# GPUI 调试接入

ProfilePilot 提供 `ppilot gpui` 和控制台的「GPUI 应用」页。每个应用实例有独立的 MCP 连接、任务会话和元素观察版本；Windows 复用现有输入观察器，macOS 使用现有 Input Guard。控制状态直接显示在目标 GPUI 窗口右下角，管理页和托盘提供接管、交还或停止入口，不创建独立控制弹窗。

## 选型（2026-11-03）

| 项目 | 能力与限制 | 本次选择 |
| --- | --- | --- |
| [themixednuts/gpui-mcp](https://github.com/themixednuts/gpui-mcp) | 框架桥、语义树、真实边界、输入、跨平台截图、标注、日志、帧性能；Windows 命名管道、Unix socket；需要 GPUI 补丁 | 首个适配器，复用 MCP stdio 服务，不重写高层输入和截图 |
| [wsp-labs/gpui-agent](https://github.com/wsp-labs/gpui-agent) | 面向 Agent 的 CLI、引用、源码定位、按工作树隔离；当前明确不支持 Windows | 参考 CLI 设计，保留未来适配空间 |
| [hexuria/gpui-agent](https://github.com/hexuria/gpui-agent) | 实验性 CLI/MCP、应用侧语义树；Windows/Linux 截图不完整 | 暂不作为默认后端 |
| [joris-gallot/gpui-devtools](https://github.com/joris-gallot/gpui-devtools) | 应用内可视化元素/布局/样式检查器 | 可作为开发者检查器补充，不替代远程协议 |

这些项目仍年轻。适配器固定 gpui-mcp commit `eb248ccf43847797b9067c47eeef1dd188dc03a6`、bridge 协议 14。上游近期 CI 的 Windows 和 Linux 通过；macOS 的一项消息回调集成测试失败（测试应用尚未注册消息接收处理器）。该消息功能未接入 ppilot。macOS 有平台实现和输入观察器适配，但尚未经本机真机验收。

上游 RustSec audit 报告工作区中 rustls、webpki 等 TLS 依赖的 7 项漏洞及若干停维警告；本次 Windows `gpui-mcp-server` 的普通运行依赖图不包含 rustls。不能把这一点当作整个上游工作区审计通过，应用侧集成仍应审核自己的 Cargo.lock。升级应同时核查两端协议。

## 构建与选择后端

后端是可选组件，普通 ProfilePilot 构建无需 Rust。准备 Rust 1.96、Windows MSVC C++ 构建工具及 Windows SDK（macOS 使用 Xcode 命令行工具）后运行：

```text
node scripts/build-gpui.mjs
ppilot gpui configure --backend <绝对路径>/dist/native/gpui/gpui-mcp.exe
```

macOS 文件名为 `gpui-mcp`。也可以在应用的「GPUI 应用」页选择后端。构建脚本固定源码提交，保留 Apache-2.0 许可证和二进制校验；本地调试会自动发现 `dist/native/gpui/`。安装包使用外部后端路径，不会隐式下载工具链。

Windows 构建会用 SDK 的 `mt.exe` 写入 PerMonitorV2 DPI 清单。实机发现未声明 DPI 感知的上游可执行文件在 125% 缩放下会重复缩放窗口尺寸，导致 xcap/WGC 取帧超时；清单修正只作用于后端进程。已有外部后端若遇到这一问题，请用本仓库脚本重建。

## 在任意 GPUI 项目接入

这不是 CDP。未接入桥的发行版不会凭空产生 DOM 或元素树。请只在开发构建启用桥，并保持 `BridgeHandle` 存活。

对于 `gpui-pre` 0.3.7，可按上游配方固定依赖：

```toml
[dependencies]
gpui = { package = "gpui-pre", version = "=0.3.7" }
gpui-mcp = { git = "https://github.com/themixednuts/gpui-mcp", rev = "eb248ccf43847797b9067c47eeef1dd188dc03a6", default-features = false, features = ["gpui-pre"] }

[patch.crates-io]
gpui-pre = { git = "https://github.com/themixednuts/gpui-mcp", rev = "eb248ccf43847797b9067c47eeef1dd188dc03a6" }
```

在创建窗口时调用：

```rust,ignore
let config = gpui_mcp::BridgeConfig::new(
    gpui_mcp::AppId::new("my-app")?, "My App"
);
let bridge = gpui_mcp::BridgeHandle::install(window, cx, config)?;
// 将 bridge 存进窗口根视图；不要在创建函数结束时丢弃。
```

完整可运行参考是上游 `examples/demo`。Zed GPUI、gpui-ce 的依赖补丁不同，见[上游接入说明](https://github.com/themixednuts/gpui-mcp#gpui-kit-gpui-pre-and-gpui-ce)。此提交支持 gpui-pre 0.3.5–0.3.7、gpui-ce 0.2.2 和固定 Zed GPUI 0.2.2；不宣称兼容更高版本。控件的稳定 `.id()`、角色和标签会改善自动化；缺少语义标签的图标可能仍需补标注。

## 使用

```text
ppilot gpui list --json
ppilot gpui claim --target <list 返回的 target_id> --session layout-task
ppilot gpui snapshot --session layout-task
ppilot gpui call --session layout-task --tool click_element --params-file click.json --observation <snapshot 返回的 UUID>
ppilot gpui snapshot --session layout-task
ppilot gpui call --session layout-task --tool screenshot --output screen.png
ppilot gpui complete --session layout-task
```

`click.json` 示例：`{"id":"save-button"}`。中文文本使用 UTF-8 JSON 文件：`{"id":"name-input","text":"你好"}`，工具为 `set_text`。`keyboard` 使用 GPUI 按键写法，如 `{"keystroke":"ctrl-a"}`。`scroll` 必须传元素 `id`。`record_performance` 的 `duration_ms` 范围为 1–10000；高亮参数示例 `{"ids":["save-button"],"ttl_ms":3000}`。

输入、标注和性能采样会消耗观察版本；读取最新 snapshot 后才能继续。元素布局或状态变化也会拒绝旧引用。用户在聊天中明确交还后，Agent 可读取 status 的 pauseId，再执行 `return-control --session TASK --pause-id UUID` 恢复同一会话，无需用户再点击应用。调用方负责获得用户同意，pauseId 仅防止旧交还请求影响新的暂停。不能改名抢占或直接释放暂停保留。具体流程见[聊天交还控制](gpui-chat-consent.md)。ProfilePilot 重启后保留原会话为暂停状态，旧 pauseId 失效。

开始会话时不弹窗或激活窗口。ProfilePilot 通过目标应用已有的 `annotations` 能力绘制右下角的小标识，显示准备中、控制中或已暂停；结束时只移除自己的标识。它是状态提示，不拦截目标应用的鼠标输入。标识使用语义根节点的逻辑边界定位，每 1.5 秒更新位置和状态；窗口最小化后无新帧或旧桥缺少能力时，管理页会说明标识暂不可用，不退回独立弹窗。标识失去续期后最多保留 5 秒，避免进程退出后留下过期状态。

此功能适用于兼容桥的 GPUI 应用，不识别或依赖 Herdr 名称。主窗口隐藏、最小化或切换页面不暂停会话。从托盘可打开现有 GPUI 应用页、暂停全部或停止全部会话；打开页面不会恢复已暂停的会话，仍须明确「交还控制」。最后一个会话结束后自动移除 GPUI 托盘。

GPUI 桥把元素点击和文字输入送入目标应用内部，无需移动系统鼠标或发送全局键盘事件。窗口在后台与最小化不同：当前 Windows 截图后端要求目标窗口未最小化。系统原生对话框等未接入桥的界面仍需单独判断控制方式。

目标窗口的鼠标点击可触发自动接管；当前共享 Input Guard 不覆盖所有键盘输入，用户打字前应先按管理页或托盘的暂停入口。操作后端超时或断开会暂停；状态标识的独立显示通道不发送输入，也不授予控制权。已发出的输入可能已生效，禁止自动重放。退出码 75 表示需要检查状态/结果。

任意应用命令执行、原始目标切换、录屏、HTML 实时编辑暂未开放给 ppilot。gpui-mcp 的 HTML 实时预览不是任意 Rust 组件的样式热更新。原生 Rust 样式仍通过改源码、编译并重新观察来迭代；可另外在项目内接入 gpui-devtools 供人手检查。

## Windows 验收记录（2026-11-03）

2026-11-05 补充：移除独立控制条，改为目标 GPUI 窗口内的状态标识。运行 `node scripts/e2e/run-gpui-embedded-preview.mjs` 可独立启动隔离的 Herdr 验收实例，使用生产 GPUI 注册入口和 Windows 输入观察器验证不创建 Electron 弹窗、应用自身帧中的标识、暂停不恢复和停止清理；不控制用户已有会话，不发送系统鼠标键盘输入。`PROFILEPILOT_GPUI_TEST_APP` 可指定兼容的 Herdr 测试构建；预览使用短路径 scratch home 和独立 core session。预览 30 分钟后退出，也可在输出的临时目录创建 `close` 文件结束它。Windows 真机验证通过；macOS 仅覆盖平台分支的模拟测试，尚未经真机验收。

在 125% 显示缩放的 Windows 实机，使用上游两个独立 Demo 实例及 Ember 编辑器验收：元素树与边界、按钮点击后的应用日志、多个实例隔离、中文输入及独立回读、元素高亮、整窗及控件截图均通过。性能接口返回帧记录及采样结果；静止窗口的采样没有新增帧，不代表实际帧率上限。

通过 ProfilePilot 的 Electron Gateway 实际点击管理页「接管」「交还控制」，核查暂停时 CLI 拒绝恢复、交还后重新观察才能输入；无效观察版本不会发送点击。闲置自动暂停也已实测。7 项 GPUI 测试及相关管理、工作区、插件回归共 34 项通过，TypeScript 和完整构建通过，插件包检查通过。

本地试用后端为固定提交的开发构建，包含 Windows DPI 清单和 `provenance.json`；发布构建请使用上述可选构建脚本。macOS 仅检查平台实现与构建差异，未作真机验证。
