# 屏幕摄像头

本功能将电脑窗口或二维码截图送入 Android 的虚拟摄像头，并在独立虚拟显示器上运行手机扫码 App。桌面入口位于手机控制区的「屏幕摄像头」；CLI 入口是 `ppilot phone camera`。手机 App 需要升级至 0.3.0。

## 支持范围

- Android 16 / API 36 及以上，且系统开放虚拟设备和虚拟摄像头服务，GPU 支持 `GL_EXT_YUV_target`。版本符合不等于设备一定兼容，开启前会实际探测。
- 使用已授权 USB 或无线调试连接，以及配套 App 的有效 control 会话。无需 root；仅状态同步、免安装模式和已暂停会话不能开启。
- Windows 使用 Electron 窗口采集与二进制 stdin 传图。macOS 使用同一采集接口，需要系统屏幕录制权限；没有引入桌面虚拟摄像头驱动。
- 目标 App 必须能在 Android 的虚拟显示器上运行并使用虚拟摄像头。厂商系统策略和 App 自身的限制需要逐机验证。

## 使用

1. 在手机工作区连接并准备手机 App，点击「屏幕摄像头」。
2. 选择当前 Profile 的浏览器窗口，在缩略图中框选二维码并保留白边。
3. 开启后选择手机扫码 App，点击「打开 App」，在右侧画面中打开扫一扫。
4. 按原有任务授权处理 App 的确认步骤，再检查原浏览器登录结果。停止摄像头会释放虚拟相机、显示器和本次关联。

CLI 操作及参数见 [手机 Agent 使用指引](../skills/profilepilot/references/phone.md#screen-camera-for-a-browser-qr-code)。图片模式只传入指定文件；窗口模式约每 300 ms 采集一次所选区域。预览约每 700 ms 刷新，适合扫码与轻量点击。

## 会话与退出

电脑端每次操作检查设备、sessionId 和 generation；Android helper 还会向配套 App 检查相同身份与控制状态。该检查不会延长控制会话的心跳。窗口关闭、用户暂停或结束、设备断线、来源窗口丢失时停止摄像头。Helper 在输入连接关闭或 6 秒无请求时清理；它不会自动恢复手机会话。

手机 App 在虚拟显示器上的画面使用独立 preview/tap 接口，不能用主显示器截图上的坐标操作。界面只结束自己创建且身份未改变的手机会话，不结束复用的会话。

## 构建与验证

```sh
npm run build:phone
npm run build
node --test tests/screen-camera.test.js tests/phone-basic.test.js tests/phones.test.js
node scripts/e2e-screen-camera-ui.mjs
node scripts/e2e-screen-camera-capture.mjs
```

`build:phone` 构建 APK 和 `dist/android/profilepilot-screen-camera.dex`。也可以单独运行 `npm run build:screen-camera`，使用 JDK 17、Android SDK 和 D8。发布工作流将 dex 和 APK 一起放入 Windows、macOS 安装包。

`e2e-screen-camera-ui.mjs` 使用明确标识的手机替身，验证区域框选、会话、App 入口和退出，**不证明真实扫码成功**。真实测试 `e2e-screen-camera.mjs` 仅操作专用可丢弃 AVD `profilepilot_screen_camera_test`（端口 5590），启动前设置 `PROFILEPILOT_CAMERA_TEST_IMAGE` 到对应本机架构的 Android 16+ 镜像目录，再执行：

```sh
node scripts/e2e-screen-camera.mjs --prepare
node scripts/e2e-screen-camera.mjs --probe
node scripts/e2e-screen-camera.mjs
node scripts/e2e-screen-camera.mjs --shutdown
```

真实测试让 debug APK 中的 ZXing 相机消费者从虚拟摄像头读到一次性二维码，再验证暂停撤销输入；能力不满足时直接失败。测试不会退化为从图片解码来宣称相机通过。

2026-10-12 的验证情况：

- 56 项屏幕摄像头/手机会话测试通过；窗口选择、框选、App 入口和停止的 UI 测试通过。
- Windows 真实桌面窗口采集、裁剪颜色/比例、源窗口关闭后的拒绝通过。
- Windows Android 17 模拟器缺少 `GL_EXT_YUV_target`，已验证能力拒绝路径；前期单独验证了虚拟设备和显示器创建。
- realme GT Neo5（RMX3700）经 Wi-Fi 实测为 Android 13 / API 33，能力检测正确拒绝，未更改手机系统或安装测试组件。
- **尚未完成兼容实体手机上的真实扫码验收，也未在 macOS 实机执行。**
- 额外执行的 `e2e-phone-console.mjs` 在创建模拟器流程等待「已创建 UI_Created_Phone」处超时，未计为通过；该脚本和对应创建界面不在本次修改范围内。

Android 接口参考：[App streaming](https://source.android.com/docs/core/permissions/app-streaming)、[AOSP virtual camera](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/services/camera/virtualcamera/README.md)。
