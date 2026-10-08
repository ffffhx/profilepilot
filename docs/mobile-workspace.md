# ProfilePilot 移动工作区

PC 版保管浏览器 Profile、模型配置与任务记录，持续执行 Agent 任务；Android 移动版用于发任务、查看进度与结果、处理确认、暂停或继续任务，以及管理已连接电脑和手机本地授权。

## 安装与连接

1. 从 [Release](https://github.com/ffffhx/profilepilot/releases/latest/download/ProfilePilot-android.apk) 下载 Android 11 及以上的签名 APK；开发时也可使用 `npm run build:phone` 生成 `dist/android/profilepilot-phone.apk`（debug 签名）。两种签名的安装包不能互相覆盖安装，切换后需重新配对。
2. PC 的「手机 → 连接移动版」可以打开 APK 所在位置。USB 连接时，原有「安装并连接手机 App」也可安装同一 APK。
3. 开启「移动版连接」，选择手机可达的电脑地址，生成二维码。
4. 手机打开「设备 → 扫码连接电脑」，核对电脑名称和地址后确认。也可粘贴配对链接，或从系统打开 `profilepilot://pair` 链接。二维码有效期三分钟，仅能配对一台设备。
5. 手机 Agent 页选择这台电脑上的 Profile，填写任务并发送。任务记录与 PC 共用，关闭手机 App 不会取消任务。

同一 Wi-Fi 通常可以直接连接。外出时，需要手机能通过 VPN 或其他已有网络访问电脑。电脑必须开机并运行 ProfilePilot。自定义地址必须使用 HTTPS；使用代理时需要保留电脑的 TLS 证书，例如 TCP/TLS 透传，普通重新签发证书的 HTTPS 反向代理会被证书固定校验拒绝。没有自动部署公网中继、云账号或穿透服务。

Windows 可能需要允许应用通过防火墙访问专用网络；macOS 也受系统防火墙与本地网络权限约束。程序不自动修改防火墙。移动协作本身不依赖 ADB；电脑操作手机时，Windows 仍可能需要厂商 USB 驱动，macOS 通常无需额外驱动。

## 手机界面

- **Agent**：选择电脑与 Profile，填写任务，选择自动执行、先计划或逐步确认；支持从其他 App 分享文字和链接，保留每台电脑的输入草稿。
- **任务**：搜索和筛选记录、查看分页执行过程和结果、下载不超过 8 MB 的任务产物、发送补充说明、暂停/继续/结束任务，以及明确回答问题、批准一次或拒绝操作。
- **设备**：扫码配对多台电脑、切换电脑、修改网络地址、移除授权；保留原有手机控制权限和本地暂停/结束入口。
- **我的**：主动开启或关闭后台任务通知，管理系统通知权限。后台连接使用可见前台服务；省电策略、强制停止、网络不可达会延迟提醒。重新打开 App 后可恢复此前主动开启的连接。

手机发任务无需无障碍或悬浮窗权限。只有 PC 查看/控制 Android 屏幕时，才使用原有的手机控制授权。两条连接的授权互不替代。

## 连接与重试

PC 默认关闭网络服务。开启后独立 HTTPS 服务监听网卡，端口首次分配后保存。配对二维码包含电脑身份、证书指纹及一次性凭据。手机固定校验该电脑证书；身份变化须重新配对。PC 只保存手机令牌的哈希；手机令牌和未确认操作由 Android Keystore AES-GCM 加密保存，备份关闭。

网络接口只开放任务和本设备断开操作，不开放完整桌面管理接口、模型密钥设置或任意本地文件导入。PC 可将手机改为仅查看，或立即撤销其授权。

手机提交前持久化请求编号，电脑在操作前持久化接收记录。超时不会自动用新编号重复执行；手机提示重试原请求或先核对任务。崩溃后无法确定的操作不会自动重放。过期请求需要先核对任务记录再清除提示。

## 验证入口

```sh
npm run check
node --test tests/mobile-service.test.js
npm run build
node scripts/e2e-mobile.mjs
node scripts/e2e-phones.mjs
node scripts/build-phone.mjs --instrumentation
node scripts/e2e-mobile-android.mjs emulator-5554
```

Android 端到端脚本仅接受可丢弃的模拟器，拒绝实体手机。它启动独立的真实任务存储和 HTTPS 服务，关闭任务调度器以避免真实模型费用或浏览器副作用，然后通过原生界面创建/控制任务，验证证书、加密凭据、重复提交、回答与撤权。测试不会把伪造设备或任务加入用户的 PC 工作区。截图与日志写入 `artifacts/mobile-workspace-20261005/`。

当前源码与安装包为 Android 移动版；没有 iOS 构建，也没有 Android/iOS 商店发布。

2026-10-05 自动验证：Windows 上 PC 完整构建通过；29 项移动接口/手机控制回归通过；PC 实际窗口的配对、授权、撤销及 IPC 边界测试通过，原有手机工作区回归通过。Android APK 构建、7 项单元测试和 lint 通过；Android 11 模拟器的原生 UI → HTTPS → PC TaskService 流程通过，覆盖创建、暂停/继续、草稿、问题回复、后台通知、重试、证书校验、凭据加密及撤权。任务调度器在此模拟器测试中关闭，没有调用真实模型或操作真实网站。

同日完成 realme RMX3700 真机升级与 Wi-Fi 配对（通过配对链接），验证四个 Tab、已有任务同步，以及新任务从手机提交、电脑调用实际模型、约 4.2 秒后将完成结果同步到手机。真机联调发现并修复首次开启服务时出现端口 0、切换 Tab 丢失 Profile 和执行方式两个问题；修正版已安装并验证选择保留。实际安装 APK 与构建输出 SHA-256 一致：`27AA271038EB06777B2867B51C39644C9CDAF1F1EFA7FB9A0119F8E33E7B8447`。本轮 PC 的 7 项移动服务测试和窗口回归、Android 7 项单元测试再次通过；lint 为 0 错误、16 警告。截图与记录在 `artifacts/mobile-real-device-20261005/`。

相机扫码、厂商长期省电策略、外网/VPN 实际连通及 macOS 硬件环境尚未验收。开发测试新增了 Android Emulator 和官方 AEHD 2.2 加速驱动；可复用的 Android 11 测试镜像与 AVD 放在 `D:/CodexBuild/ProfilePilotMobileTesting/`，未使用的 Android 16 测试镜像已清理。PC 应用以独立 WMI 启动器运行；真机配对已保留，测试控制会话已结束。
