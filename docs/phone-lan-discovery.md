# 手机 App 局域网发现

桌面「添加 Android 设备 → 通过 Wi-Fi 连接」打开后自动扫描，每轮结束后 5 秒刷新；关闭或进入配对步骤后停止刷新。手机只需安装新版 ProfilePilot 并打开 App，发现不依赖开发者选项、无线调试、USB、状态同步或电脑配对。选择设备后再开启无线调试并完成 Android 系统配对。

手机主界面、连接服务或状态同步服务运行时响应发现。离开主界面且没有服务运行时保留 2 分钟，便于前往系统设置，然后释放网络监听和 Wi-Fi 多播锁。系统强停、休眠或首次安装后从未启动的 App 不能响应，请重新打开。旧版 App 仍可通过无线调试发现或手动地址连接。

发现使用 UDP 41243，多播组为 `239.255.80.80`，同时发送当前网卡子网广播。电脑使用各局域网 IPv4 网卡的临时端口接收单播回复，单轮最多 2.4 秒；不依赖网卡名称、系统 Bonjour 或 ADB。Windows 应允许专用网络访问，macOS 应允许本地网络访问；路由器设备隔离会阻止发现。

请求为 `protocol: profilepilot-discovery-v1`、`type: scan` 和随机 32 位十六进制 `nonce`。回复回显 nonce，并提供临时 UUID、型号、App 版本、开发/正式版和无线调试状态。回复来源必须属于当前网卡子网，JSON 有长度和字段约束；手机限速响应。UUID 在发现服务重建后改变，不作为配对身份。发现不发送凭据、硬件序列号或控制端口，不自动配对、连接或开始控制；原有控制服务仍只监听回环地址。

验证：`node --test tests/phone-lan-discovery.test.js`、`node scripts/e2e-phone-nearby.mjs`；Android 协议测试与 lint 随 `npm run build:phone` 执行。macOS 与 Windows 共用网卡枚举及收发实现，需分别在实际网络验收。
