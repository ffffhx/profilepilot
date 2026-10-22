# 本地视觉跟随

入口：桌面 App → 手机工作区 → **视觉跟随**。

用 OpenCV 在小地图中匹配自己和指定队友的图标，用 A* 在校准的障碍网格上寻路，通过 ProfilePilot 手机会话持续操作摇杆。图像在电脑本机处理，无需大模型或模型 API Key。

## 没有设备时

点击 **演示地图 → 开始演示**。绿色图标会根据真实 OpenCV 返回的位置和路线移动，绕开中间墙壁。可以停止后修改障碍，再观察路线变化。该地图是合成演示，不是王者游戏实测。

也可以导入游戏截图，依次框选小地图、自己图标、队友图标，涂出障碍并分析。导入多张截图后可按选择顺序回放；回放不会操作手机。

## 连接设备后

1. 更新到包含此功能的手机开发版，连接 ProfilePilot，开启所需的无障碍与控制状态权限，结束已有手机会话。
2. 在训练或自定义对局中打开横屏游戏，点击 **获取手机画面**。
3. 框选完整小地图，再紧贴边缘框选自己的图标和指定队友的头像。图标必须能够区分；相似或重叠头像可能无法可靠识别。
4. 在小地图上涂出不可行走区域；**绕墙留白**控制额外避让范围。当前需要手动标记，不会自动理解游戏地形。
5. 点击 **摇杆中心**后在画面上点选固定摇杆中心，调整半径、方向角度、跟随距离，保存校准。
6. 先点击 **仅观察手机**检查识别与路线，再停止观察，点击 **开始跟随**。需要实机校准地图方向与摇杆方向的关系；不能假定所有游戏、分辨率和布局都相同。
7. 桌面停止、关闭跟随窗口、手机暂停/结束、断线或会话改变都会终止跟随。不会自动恢复手机上主动暂停的会话。

Android 11 以下的模拟器可在**控制方式**中明确选择**免安装 · 分段移动**，无需安装手机 App。此模式沿用 basic 会话，每次拖动最多 350 ms，完成后释放，再获取画面；暂停后不会提交新动作，已提交的短拖动可能完成。移动速度受截图和传输延迟影响，不能等同于手机 App 的连续触控。某些模拟器的直接截图流会截断，桌面会校验完整 PNG，并在同一有效会话中通过临时文件重新截图。

识别丢失、匹配不唯一、连续帧未确认、没有路线或位置卡住时不发送移动方向。App 模式触控带有最长 1.5 秒有效期，当前发送值为 1.2 秒；没有新指令时自动松开。App 模式单帧处理超过 1 秒、basic 模式超过 3 秒时跳过该帧移动。当前截图循环默认间隔 400 ms；App 模式从上次截图响应完成后计时，避免 Wi-Fi 请求延迟波动压缩手机实际收到的两次截图间隔。视觉分析和触控耗时计入这段等待，basic 模式仍按循环开始时间计时。实际帧率在界面显示，受手机截图与传输速度限制，并非 20 FPS 视频流。

连续识别允许 App 模式最多 1.5 秒、basic 模式最多 4 秒的帧间隔；间隔更长时需要重新确认目标。这个间隔只决定是否保留识别历史，不会放宽上述单帧移动时限。低帧率时会延长位置历史的保留时间，以便卡住检测仍能积累四次观察。

Windows 已安装的腾讯手游助手可通过 `ppilot phone emulator-list` 列出的 `Tencent_GameLoop` 连接；该入口复用或启动默认 100 号引擎，验证其本机调试端口和窗口位置。手游助手要求管理员权限，首次启动可能出现 Windows 授权弹窗；ProfilePilot 本身保持普通权限。连接不会安装 App 或开启控制会话。macOS 不显示此 Windows 引擎。

## 视觉运行环境

需要 Python 3.10+，以及 OpenCV、NumPy。界面会检查已安装环境；**安装视觉组件**在 App 数据目录建立独立虚拟环境，安装 `opencv-python-headless==4.12.0.88` 和 `numpy==2.2.6`。使用 Python 3.10–3.13 可匹配这组固定依赖的预编译包。未安装 Python 时先安装 Python，再重启 App。

Windows 查找 `python` 和 `py -3`，macOS 查找 `python3`；也可用 `PROFILEPILOT_PYTHON` 指定解释器绝对路径。运行时优先使用 App 自己的视觉虚拟环境。打包版本将 Python 脚本放在 `app.asar.unpacked/public/vision`。

## CLI

```text
ppilot phone follow runtime
ppilot phone follow setup
ppilot phone follow load
ppilot phone follow save --config calibration.json
ppilot phone follow start --device <实际设备ID> --config calibration.json --mode observe
ppilot phone follow status
ppilot phone follow stop --run-id <status返回的runId>
ppilot phone follow start --device <实际设备ID> --config calibration.json --mode control
ppilot phone follow start --device <实际模拟器ID> --config calibration.json --mode observe --backend basic
ppilot phone follow analyze --params-file frame.json
```

`start` 默认 `observe`。CLI 启动的任务由桌面 App 托管，命令退出后继续运行，直到显式停止、手机暂停/断线或 App 退出。`load` 返回 `{ ok, data }`，其中 `data` 是可保存为 `calibration.json` 的配置；`analyze` 的文件内容为 `{ "config": <配置>, "frame": { "mime": "image/png", "base64": "<不含data前缀>", "width": 1280, "height": 720 } }`。

配置类型见 `src/shared/game-follow.ts`。模板为 PNG 的 base64；小地图、摇杆中心和检测坐标均为 0–1 归一化坐标，摇杆半径以屏幕短边为基准。分辨率或屏幕方向改变后需要重新校准。

## 验证与范围

```text
npm run build
npm run build:phone
node --test tests/game-follow.test.js
node scripts/e2e-game-follow.mjs
node scripts/preview-game-follow.mjs
```

测试覆盖真实像素匹配、连续帧确认、完整绕墙闭环、目标丢失与歧义、卡住释放、会话取消，以及桌面校准/演示/保存流程。界面测试中的手机 I/O 是模拟的；独立预览运行实际桌面 App，使用单独数据目录并关闭设备轮询。

当前实现是基础视觉跟随，不包含自动放技能、治疗、逃跑或战斗决策。真实游戏中的成功率、持续触控兼容性和方向参数仍需连接设备验证。Windows 上已执行本地构建和界面测试；macOS 路径及进程启动方式已适配，但尚未在 macOS 真机运行。

### Android 持续触控回归

Android 的续接手势若只有不变的触点、没有按下、移动或抬起事件，会被判为失败。保持摇杆方向时应保留已经按下的触点，等方向变化再续接；本地仍每 80 ms 检查会话授权和指令有效期，到期或停止时提交抬起。坐标统一取整，避免亚像素变化在 Android 内部取整后变成空手势。对应系统行为见 [Android 13 MotionEventInjector](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android13-release/services/accessibility/java/com/android/server/accessibility/MotionEventInjector.java)。

`FollowTouchTest` 使用开发版的本地空白测试页面，检查持续按住、转向、主动释放、指令过期与撤销授权。先运行 `node scripts/build-phone.mjs --instrumentation`，安装开发版和测试 APK，再由测试宿主执行该测试类。测试需要已授权且实际运行的无障碍服务，不会修改系统权限。Instrumentation 会重启配套进程，测试宿主必须恢复连接；不要把受管命令因 App 重启而断开误报为测试成功。本次经用户明确授权使用 ADB 等待 instrumentation 完整结果，并通过 `ppilot phone connect` 和 `accessibility-repair` 恢复服务；不能因此为其他任务推断原生 ADB 授权。

2026-10-22 真我 GT Neo5 SE 真机 `FollowTouchTest` 已通过：保持按下后继续移动、显式松手、TTL 到期松手和授权失效松手均符合预期。测试使用独立测试页面；它验证触控链路，不代表整局游戏的图像识别和路线跟随质量已通过验收。

### 2026-10-22 训练场短时实测

Windows 通过 Wi-Fi 连接真我 GT Neo5 SE，在单人练习场用小乔跟随固定位置的狄仁杰。短时测试发现 Android 截图错误码 3，即[截图调用间隔太短](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT)。原循环从电脑发起请求时计时；上一请求延迟较大、下一请求延迟较小时，手机收到的两次请求可能过近。现改为从截图响应完成后计时，保留原有画面时效、触控 TTL 和失败停止机制。新增回归测试模拟前一次请求延迟 300 ms、后一次立即到达；旧实现失败，修复后 14 项跟随测试通过。此调度使用跨平台 TypeScript，没有新增 Windows 专用路径；真机验收仅在 Windows 完成。

修复后一次 18 秒控制测试处理 31 帧、发送 21 次方向更新，约 1.7 FPS，无截图间隔错误。小乔沿下路向目标移动；接近时头像重叠导致置信度下降，脚本停止移动。将本次校准的跟随距离从 0.07 调整为 0.14 后，再次运行 17 秒，处理 27 帧、发送 16 次方向更新，约 1.6 FPS；第 18 帧进入 `near`，后续位置保持稳定，未继续发送移动方向。该距离是此次头像尺寸和地图校准的参数，不修改通用默认值。

验证覆盖截图、识别、连续移动、接近后停止及结束释放；目标 AI 固定、路线为手工校准的下路片段。这一轮不包含动态队友长时间跟随、完整地形绕障或整局表现，不把短时通过视为这些能力已验收。原始截图、采样和校准保留在本机，未提交到仓库；测试结束后关闭控制会话并将训练场置于设置暂停画面。

### 2026-10-22 整局动态跟随：未通过连续稳定性验收

同一真机重新开启单人练习场，保持队友 AI 行动；随机选中队友头像第 3 位宫本武藏，小乔跟随。根据开局小地图补全本地通路校准，跟随距离保持 0.14。观察到跨上下野区追随、目标走远后再次追赶、靠近后停止，以及小乔回到泉水后再次出发。最终观察到胜利画面及英雄结算页，但不能把对局胜利当作跟随质量通过。

第一段采集 739 帧、发送 232 次方向更新，约 1.7 FPS；在游戏约 8 分钟时出现本地 ADB 转发端口 `ECONNREFUSED`，任务自动结束。检查确认手机与配套 App 实例未重启，无障碍正常、会话已由电脑结束，连接恢复后重新开始第二段；该中断仍计入失败。第二段采集 460 帧、发送 122 次方向更新，约 1.6 FPS，直至观察到结算后停止。合计 1,199 次截图、354 次方向更新，截图数包含结算画面，不能视为全部是有效识别帧。

多人交战、头像重叠时频繁进入 `lost` 并松开摇杆，目标离开遮挡后可重新识别。527 个状态采样包含 268 个 `lost`，其中也包括死亡/回泉水过程和无小地图的结算画面，不能直接换算成有效对战识别失败率。连接中断的最初触发原因尚未确定；转发错误和头像遮挡都是仍待处理的问题，未通过“全程一直稳定跟着”的验收。

结算核对期间控制会话又变为暂停，未重放点击或恢复该会话；已结束自己的控制，手机在线且空闲。原始截图、分段采样、随机选择和校准仅保留在本机临时测试目录，没有提交游戏账号画面或设备凭据。
