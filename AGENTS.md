修改完项目后，要把项目跑起来给用户看。

启动项目时，必须作为独立于 Codex 或临时终端会话的独立进程启动，避免终端会话结束时连带关闭项目；启动后要确认独立进程仍在运行。

启动或重新打开 Android 模拟器，统一使用 `ppilot phone emulator-list` 和 `ppilot phone emulator-connect --name <实际名称>`，或桌面 App 的“启动 / 连接模拟器”。这些入口会校验 Windows 窗口位置并自动缩放归位。不要直接用 emulator.exe、Start-Process 或 CIM 启动模拟器而绕过窗口检查；CLI 不支持上述命令时先构建并更新项目 CLI。交付预览前须确认标题栏和窗口均在当前显示器工作区内；窗口修正失败时继续排查，不把启动进程成功当成预览成功。

不要因为代码改动而自动修改 README.md；只有我明确要求修改 README.md 时再改。

排查问题时，要检查是否存在 Windows 和 macOS 的兼容性差异。

安卓 App 例外：日常本地与手机均使用开发版。修改 android-phone 或安卓构建/发布依赖后 push 到 main，由 android-development.yml 自动构建、使用与本地相同的固定开发签名并发布到 android-dev-latest，手机可直接检查并更新开发版。已明确授权此自动构建，无需每次推送再询问；使用 npm run build:phone 构建，保留固定开发密钥，版本号由脚本生成以兼容在线更新和本地调试。正式版 android-latest 仅在明确发布时通过 release.yml 手动/tag 构建。

其他代码 push 到 main 不自动构建/发布。官网部署 deploy-pages.yml 仍手动触发；Windows/macOS 安装包仅在手动运行 release.yml 或推送 v*.*.* tag 时构建。要额外触发这些构建时，先问我：
- 要：push 完用 `gh workflow run <workflow>`（如 `deploy-pages.yml` / `release.yml`）手动触发对应构建。
- 不要：只 push 代码；若包含安卓改动，仍按上述规则自动发布安卓更新。
