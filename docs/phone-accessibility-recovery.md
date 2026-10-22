# 无障碍恢复

`ppilot phone accessibility-repair --device <实际设备 ID> [--auto-restore on|off]` 是显式授权的准备操作，不依赖已启动的控制会话。它要求配套 App 已配对，且会话处于 idle/stopped；活动或暂停会话会拒绝。必要时通过 ADB 授予 App `WRITE_SECURE_SETTINGS`，再通过鉴权 RPC 由 App 修改自己的无障碍设置。这样也适用于普通 shell 无权写 secure settings 的系统。

修复同时检查服务列表 `enabled_accessibility_services` 和总开关 `accessibility_enabled`。真机曾出现自己的组件仍在列表中、总开关为 0 的状态；旧恢复只检查列表并重绑定，无法正确处理它。重绑定移除最后一个服务时也可能影响总开关，短事务完成时现在会一并恢复总开关；保留其他服务列表及并发修改检查。不能仅凭该状态推断最早关闭开关的进程。

`on` 显式保存“自动开启无障碍”，默认关闭；它也启用后台恢复，但不会额外开启无线调试的高级恢复。App/连接服务重启或检测到服务设置关闭时尝试恢复，持久化预算限制为每 30 分钟 3 次。首次开启此选项建立新的预算窗口。总恢复开关或该选项关闭后停止自动开启；用户要让系统无障碍保持关闭，应先关闭此选项。`off` 关闭自动开启，但本次命令仍修复当前状态。省略选项只修复本次，不改变偏好。

修复不会启动、恢复控制任务或重放输入。强行停止会阻止 App 自己运行；下次打开 App 或显式 `phone connect` 后才能恢复。厂商后台限制、撤销 ADB/系统设置权限仍可能阻止恢复，不能保证被系统强停后持续运行。

验证：`npm run build:phone` 包含单元测试与 Lint；`node scripts/build-phone.mjs --instrumentation` 额外构建测试 APK。主机的 `phones.test.js`、`phone-wireless-cli.test.js` 覆盖无障碍关闭时的准备入口、暂停保护与参数。

2026-10-22 在 Android 13 真我 GT Neo5 SE 上执行 `AccessibilityRecoveryTest` 通过：人为关闭总开关后，自动恢复总开关和实际服务绑定，保留原服务列表且没有活动会话。首次回归发现系统将被测试框架重启的服务保留在 crashed 列表，单独开启总开关不足以恢复；修复入口现在也会通过短事务重新绑定。另已验证 `am force-stop` 后显式重新打开 App，4 秒后 readiness 就绪且没有控制会话。强停期间不承诺自动唤起。

Windows/macOS 共用同一 ADB 参数数组和手机 RPC，不依赖主机 shell 语法。本次真机验证使用 Windows；macOS 组合未做现场验证。
