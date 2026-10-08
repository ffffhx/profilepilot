# 手机状态同步

手机主动把诊断状态发到 HTTPS 服务，电脑读取自己的配对通道。双方只需能访问服务，无需 USB、ADB、同一局域网或电脑开放入站端口。查看屏幕和操作手机仍使用原有控制连接。

## 使用

1. 安装本次构建的 Android App。
2. 电脑「手机 → 设备设置 → 未连接电脑时也同步手机状态」生成配对码；尚无手机时可点「手机不在身边？先同步手机状态」。
3. 手机「设备」页扫码或粘贴链接，核对服务器地址后开启同步。配对码三分钟内有效。
4. 手机每十五秒上报，电脑每十秒读取；四十五秒未上报后权限显示为待确认，同时显示最后上报时间。
5. 手机设备页和常驻通知可以停止同步；电脑「移除此状态同步」会撤销该通道的读写凭据。

上报字段包括手机名称、App 安装标识、无障碍服务、悬浮窗、通知、锁屏和可读取的调试开关。0.2.2 起还包括当前 Wi-Fi 私有 IPv4 地址及手机通过系统服务发现获得的无线调试端口、观察时间；切换网络清除旧端口，未发现端口时只上报 IP。不上传屏幕内容、任务文本或控制凭据。部分 Android 调试开关无法由普通 App 准确读取，显示实际未知原因，不把读取到的零值猜成关闭。

点击已绑定手机的「通过 Wi-Fi 连接」会自动查找该手机，检查端口可达性并连接；过期地址会重新发现一次，连接后核对已知硬件身份。CLI 对应 `ppilot phone wireless-connect --device <ID>`，`wireless-discover --device <ID>` 可查看当前候选地址和失败原因。初次系统配对和手动地址仍有独立入口，不会自动开始控制或恢复暂停会话。准备状态显示「连接条件已就绪」，实际连接成功才显示「已连接」。Windows 与 macOS 共用发现和 TCP 检查代码；macOS 的本地网络权限、两端防火墙以及路由器设备隔离仍可能阻止连接。

后台上报受 Android 省电和强制停止影响；重新打开 App 会恢复用户此前开启的同步。当前手机版保存一条状态同步配对，可通过重新扫码更换。此功能不授予控制会话，也不会自动恢复暂停的任务。

## 服务

默认入口为 `https://124-221-36-36.anyip.dev:8443/profilepilot-status`，也可在配对窗口填写自建 HTTPS 地址。此环境的 443 端口从 Windows 访问被重置，8443 已验证可达。Windows/macOS 使用同一 HTTPS 协议，不依赖厂商 ADB 驱动；macOS 实机尚未验证。

服务源码为 `services/phone-status/server.mjs`，使用 Node 20 及以上、无第三方依赖。systemd 样例和 Caddy 路由放在同一目录。服务绑定 `127.0.0.1:8798`，只在已有 HTTPS 站点内导入路由；不应直接对公网暴露内部端口。

`STATUS_DATA` 目录保留通道及凭据哈希；诊断数据只放内存，最长保留一天，重启后等手机重新上报。手机使用 Android Keystore 加密保存上传凭据；电脑读取凭据仅保存在本机数据目录的 `phones/status-channels.json`。读写凭据互不通用，状态通道没有控制接口。未使用的配对自动过期，通道总数和请求频率有上限。

腾讯云部署：`/opt/profilepilot-phone-status`，服务名 `profilepilot-status`，状态目录 `/var/lib/profilepilot-phone-status`；Caddy 路由 `/etc/caddy/profilepilot-status.caddy`。部署前保留了原 Caddy 配置，检查配置后 reload，原有站点继续使用原配置。

## 检查

```sh
npm run build
node --test tests/phone-cloud.test.js tests/phone-presentation.test.js tests/phone-devices.test.js tests/phones.test.js
node scripts/e2e-phones.mjs
node scripts/build-phone.mjs --offline
node scripts/verify-phone-status.mjs https://HOST:PORT/profilepilot-status
```

公网验证脚本建立临时通道验证上报、读取与读写凭据隔离，最后撤销通道；不连接真实手机。
