# 安卓手机工作区

手机工作区管理通过 ProfilePilot 发起的查看和控制会话。电脑显示设备、控制者、任务、持续时间与最近动作；安卓配套 App 在会话期间显示可拖动的顶部胶囊和状态通知，均可暂停或结束控制。

## 开发与连接

需要 Node.js、JDK 17 或更新版本、Android SDK（platform 37、Platform Tools）。设置 `JAVA_HOME` 和 `ANDROID_HOME`，运行：

```sh
npm run build:phone
npm run start:independent
```

手机构建包含单元测试与 Android lint，输出 `dist/android/profilepilot-phone.apk`。默认是开发用 debug APK；GitHub Release 提供使用固定发布签名的 `ProfilePilot-android.apk`，桌面发布包同时包含该 APK。普通本地桌面构建不下载 Android 工具链；需要随桌面安装包分发 APK 时，先执行手机构建。

发布构建使用 `node scripts/build-phone.mjs --release`，要求环境变量 `ANDROID_RELEASE_KEYSTORE`、`ANDROID_RELEASE_STORE_PASSWORD`、`ANDROID_RELEASE_KEY_ALIAS`、`ANDROID_RELEASE_KEY_PASSWORD`。CI 从仓库的 `ANDROID_RELEASE_KEYSTORE_BASE64` Secret 还原密钥文件，其他三个值使用同名 Secret；密钥和密码不进入源码、日志或 Release 附件。

debug 与 release 使用不同签名，不能直接互相覆盖安装；切换前保存需要的本机资料，安装后重新配对。后续发布始终使用同一发布签名，维护者应妥善备份密钥。参见 [Android 官方签名说明](https://developer.android.com/studio/publish/app-signing)。

支持 Android 11/API 30 及以上。可使用 USB 调试或下方的局域网无线配对引导。Windows 某些设备的 USB 连接需要厂商 ADB 驱动；macOS 通常无需额外驱动，无线连接不依赖 USB 驱动。默认从 SDK 或 PATH 查找 ADB，也可设置 `PROFILEPILOT_ADB_PATH`。

在「手机」工作区选择设备，点击「安装并连接手机 App」，按手机系统提示确认安装。手机 App 中确认电脑配对，开启顶部胶囊（显示在其他应用上层）、通知、ProfilePilot 手机控制无障碍服务。权限由手机用户确认，电脑不会代开。

连接完成不会自动开始控制。可选择「仅查看」或「开始控制」。查看画面按需截图，不是实时视频；控制模式支持点按、拖动、导航键，以及向当前输入框写入文字。安全窗口可能拒绝截图或隐藏悬浮窗。

## 同一局域网无线配对

Agent 可以直接使用 ProfilePilot CLI 发现、配对和连接手机，无需操作桌面向导。先检查当前连接，再发现无线地址：

```sh
ppilot phone list
ppilot phone wireless-discover
ppilot phone wireless-connect --address CONNECTION_IP:CONNECTION_PORT
ppilot phone connect --device RETURNED_WIFI_DEVICE_ID
```

将示例参数替换为实际结果。已在线且配套 App 就绪的 Wi-Fi 设备可以直接建立会话，不必再次配对或连接 App。同一手机可能同时保留“USB 已断开”和“Wi-Fi 已连接”两条记录，应使用当前在线的无线设备 ID。离线记录里的会话和权限是上次状态，不能当作当前连接证据。

首次无线配对时，将手机配对弹窗的地址和六位码写入临时 UTF-8 JSON 文件（支持 BOM）：`{"address":"PAIRING_IP:PAIRING_PORT","code":"SIX_DIGIT_CODE"}`，执行 `ppilot phone wireless-pair --params-file PAIRING_JSON_FILE`，提交后删除临时文件。随后使用主页面的连接端口执行 `wireless-connect`；配对码不应出现在命令行参数或持久记录中。CLI 命令不自动开始控制，也不恢复已有暂停会话。

也可在电脑端「手机」右上角点击 **无线连接手机**，按三步引导连接；手机 App 首页提供 **Wi-Fi 连接指南**，可打开本机开发者选项。

1. 手机和电脑接入同一局域网（电脑可使用网线）。在 Android 11 或更新版本的「开发者选项 → 无线调试」开启功能，并在手机确认网络授权。
2. 手机选择「使用配对码配对」，保持弹窗打开。电脑可自动发现配对地址，也可手动输入弹窗中的 IPv4 地址、配对端口及 6 位码，点击「配对这台手机」。
3. 配对成功后回到手机的无线调试主页面，读取「IP 地址和端口」。在电脑选择发现的连接地址或手动填写，再点击「连接手机」。**连接端口通常不同于配对端口。**
4. 点击「连接手机 App」，首次安装/配对仍需在手机完成权限确认，然后才可开始查看或控制会话。已有 USB 配对记录会在确认同一物理设备后复用，正在进行的会话不会被新的连接步骤覆盖。

以后可使用「已配对，直接连接」。网络切换或重新开启无线调试可能改变连接端口，应以手机当前显示的信息为准。自动发现使用 ADB mDNS；访客网络、客户端隔离、Windows 防火墙、macOS 本地网络权限可能影响发现或连接，可先手动填写地址排查。ADB 不支持 `pair` 时需更新 Android Platform Tools。

当前引导支持局域网私有 IPv4 地址（10/8、172.16/12、192.168/16 及链路本地 169.254/16），不提供公网穿透或 IPv6 配对。依据 Android 11+ 的 TLS 无线调试流程实现，未启用旧式 `adb tcpip 5555`。配对码只通过子进程标准输入传递，不放在进程参数、持久配置或日志中；提交后立即清空输入框。配对成功只建立 ADB 信任，不自动安装 App 或启动控制。连接流程遵循 [Android 官方无线调试说明](https://developer.android.com/tools/adb)。

开发验证：`node --test tests/phone-wireless.test.js` 覆盖地址校验、配对码传输与错误脱敏、mDNS 配对/连接端口区分、ADB 返回失败但退出码为零、设备就绪确认、USB/Wi-Fi 授权复用及已有会话保护。`node scripts/e2e-phones.mjs` 覆盖完整引导、失败重试、端口误填、输入框清空、重新打开及「已配对」分支，使用隔离设备替身。

## Agent 接入

统一名称为 **ppilot phone CLI**（ProfilePilot Phone CLI），入口是 `ppilot phone`。它提供设备管理、查看与控制会话，以及 ADB 兼容命令。ADB Wrapper 是内部兼容层：设备连接使用 ADB，受支持输入交由手机配套 App 校验并执行。

```sh
ppilot phone list
ppilot phone start --device <ID> --controller Codex --task "检查应用设置" --mode control
ppilot phone pause --device <ID>
ppilot phone stop --device <ID>
ppilot phone --help
```

动作通过 JSON 文件发送，必须携带 `list` 返回的会话 ID、generation 和一个新的 UUID：

```json
{
  "id": "设备 ID",
  "sessionId": "当前会话 ID",
  "generation": 1,
  "requestId": "新的 UUID",
  "action": { "kind": "screenshot" }
}
```

```sh
ppilot phone action --params-file action.json --output screen.jpg
```

支持 `tap`、`swipe`、`text`、`key`、`snapshot`、`screenshot`，以及下方的控件定位操作。`text` 使用无障碍 `ACTION_SET_TEXT` 替换当前输入框内容，支持中文。暂停、结束、断线后不得自动恢复，也不得把失败输入换个 UUID 重放；先读最新状态，用户明确恢复后再继续。

## 控件定位与流程复用

这些能力直接包含在 ProfilePilot CLI 与手机 App 内，无需另装手机自动化 App。桌面、CLI 和 APK 均需更新。通过同一个无障碍服务执行，保留顶部胶囊、通知、会话归属和暂停/结束机制；没有新增三方自动化引擎。

`selector` 支持 `resourceId`、`text`、`description`、`className`、`packageName`，以及 `enabled`、`checked`、`editable`、`clickable`、`scrollable`。多个条件按 AND 精确匹配当前可见控件；优先使用应用的完整资源 ID，可补充文字、包名或状态。`checked: false` 只匹配可勾选控件，不匹配普通按钮。密码内容保持脱敏。

| action.kind | 参数及行为 |
| --- | --- |
| `find` | `selector`；返回 `count` 与 `matches`，仅查看模式也可用 |
| `click` | `selector`；执行控件点击，文字节点可使用最近的可点击父级 |
| `fill` | `selector`、`text`；直接替换指定输入框，支持中文及空字符串清空，无需预先聚焦 |
| `scroll` | `selector`、`direction: "forward" / "backward"`；滚动指定容器，返回 `performed` |

点击、输入和滚动执行前会重新定位；没有匹配、多个匹配、禁用控件、控件树不完整都会报错。系统拒绝控件点击时不会自行改用坐标。游戏、自绘 Canvas 或未提供无障碍语义的控件仍可能需要观察截图后使用已有坐标操作。

重复测试可保存为 UTF-8 JSON，再通过 `run` 执行：

```json
{
  "version": 1,
  "name": "检查表单保存",
  "timeoutMs": 30000,
  "steps": [
    { "kind": "wait", "selector": { "resourceId": "com.example.app:id/name" }, "timeoutMs": 5000 },
    { "kind": "fill", "selector": { "resourceId": "com.example.app:id/name" }, "text": "中文测试" },
    { "kind": "click", "selector": { "text": "保存", "clickable": true } },
    { "kind": "wait", "selector": { "text": "已保存" } },
    { "kind": "assert", "selector": { "text": "保存失败" }, "condition": "absent" }
  ]
}
```

```sh
ppilot phone run --device DEVICE_ID --file "flows/save-form.json" --output-dir "artifacts/phone-runs"
```

请把示例资源 ID 替换为目标 App 的实际值，先打开对应页面。Windows 和 macOS 使用同一 JSON 格式；Windows PowerShell 写入的 UTF-8 BOM 可被读取，含空格路径加引号。流程不执行 shell 命令，也不会自行安装/启动被测 App。

除所有原子动作外，流程还支持：

- `wait`：等待唯一目标出现（默认 `condition: "visible"`）或消失（`"absent"`）；默认 5 秒，最多 30 秒。
- `assert`：立即断言唯一目标可见或目标不存在，不等待。断言失败停止后续步骤。
- `scrollUntil`：提供目标 `selector` 与容器 `container`，按 `direction` 滚动直到找到目标。默认最多 10 次（上限 30），每次滚动后最多观察 600 毫秒，可用 `settleMs` 设置 100–2000 毫秒。无法继续滚动或达到次数上限会失败。

示例：`{"kind":"scrollUntil","selector":{"text":"Case 30"},"container":{"resourceId":"io.github.profilepilot.phone:id/bench_list"},"direction":"forward","maxScrolls":10}`。仓库的 `scripts/e2e/fixtures/phone-developer-flow.json` 在 debug APK 的离线测试页上验证中文表单、状态变化、对话框和长列表。开发版手机 App 的「我的 → 手机控制测试页」可打开此页面，正式 release APK 不含测试页及入口。

流程最多 100 步，总时限默认两分钟、最多五分钟；时限在请求前后检查，正在执行的单次 Android 请求仍受现有传输超时约束。运行前校验整个文件并申请独占会话，已有会话会拒绝新流程。纯读取流程默认 view，包含输入则默认 control；显式 view 不能执行输入。结束或失败后释放自己的会话。

流程只重复读取观察；输入失败、结果不明、暂停、结束或断线都停止，不自动恢复或重放。重新运行是从第一步执行一轮新流程，需先确认页面及上次动作结果。CLI 成功退出码为 0，失败为 1；标准输出包含每步耗时与失败步骤，不记录输入内容。只有显式指定 `--output-dir` 才创建本地报告；失败画面与快照仅在原会话仍有效时采集，可能包含当前页面内容，暂停/断线后不另开会话取证。

## 状态与边界

- 手机拥有控制会话的最终授权；暂停或结束会递增 generation，使已排队的旧指令失效。已交给 Android 执行的手势可能完成，最长两秒；不会再接受后续指令。
- 电脑每两秒同步状态。手机八秒收不到心跳会停止接受指令。短暂断线后电脑也会先暂停仍存活的会话；完全过期后需要新建会话。重启不会自动恢复控制。
- 锁屏、关闭必要权限、停止配套服务会暂停或结束控制。退出桌面应用会尽力结束会话；电脑崩溃时由手机心跳超时兜底。
- 手机服务只监听 `127.0.0.1`，通过 ADB 转发和每设备随机凭据连接；不会监听手机局域网。截图和页面内容按请求返回，不写动作内容日志。
- 通过下方 Wrapper 启动的工具，其受支持 ADB 命令纳入此会话。绕过 Wrapper 直接调用原生 ADB、scrcpy 或其他远控软件的操作不受此会话管理，也无法可靠归属。
- 第一版不包含实时视频、厂商原生灵动岛、操作轨迹、跨网络中继。

## ppilot phone CLI：接入已有 ADB 工具

先在手机工作区安装/更新配套 App、完成权限设置并结束已有会话，然后启动脚本：

```sh
ppilot phone wrap --device <ID> --controller "Agent 名称" --task "检查应用" -- python script.py
```

也可以启动一个托管终端：Windows 使用 `-- powershell.exe -NoProfile`，macOS 使用 `-- /bin/sh`。从该终端运行的程序继承 Wrapper 环境。需要手动恢复已暂停会话时，在手机工作区点击「恢复会话」，然后发出新的操作；不会重放失败命令。

脚本仍可使用 `adb -s <ID> shell input tap 100 200`，或用 `ADB` 环境变量中的绝对路径调用 Wrapper。托管入口只为其子进程设置 PATH、ADB 和 ANDROID_SERIAL，不改全局 PATH，不覆盖已有的三方 ADB 安装。Windows 提供真正的 `adb.exe`，支持 Node execFile/Python subprocess，无需 cmd.exe；macOS/Linux 使用可执行 sh 入口。Windows 启动 .cmd 工具时须显式指定解释器或实际 exe（例如运行 node 与脚本路径），入口不会隐式调用 shell。

支持的命令：

| 命令 | 行为 |
| --- | --- |
| `devices [-l]` | ADB 文本格式的设备列表；托管任务中只列出指定手机；任务外 `ppilot phone adb devices` 不开始控制 |
| `get-state` / `get-serialno` | 返回托管设备连接状态/标识 |
| `shell input [touchscreen] tap X Y` | 点按整数物理坐标 |
| `shell input [touchscreen] swipe X Y X2 Y2 [MS]` | 50–2000 毫秒的滑动，默认 300 毫秒 |
| `shell input keyevent 3/4/187` | Home/Back/最近应用，也支持对应 KEYCODE 名称 |
| `exec-out screencap -p` / `shell screencap -p` | 原始屏幕尺寸的二进制 PNG，最大 5 MiB；不会缩放或偷偷返回 JPEG |

截图保存建议在脚本里直接写二进制文件，或使用 `ppilot phone adb --output screen.png exec-out screencap -p`。Windows PowerShell 5.1 的 `>` 不保证保留二进制字节。不支持 `input text`：现有无障碍文字能力会替换输入框，与 ADB 键入语义不同，不能冒充兼容。

`ppilot phone --help` 查看全部手机命令，`ppilot phone adb --help` 查看 ADB 兼容范围。旧的 `ppilot adb` 继续作为 `ppilot phone adb` 的兼容别名。托管子进程仍可调用 `adb`，Windows 的 `adb.exe` 与 macOS/Linux 的 `adb` 入口均转入 `ppilot phone adb`。

任意 shell、shell 拼接/脚本、安装卸载、端口转发、自选 ADB server、后台进程和 scrcpy 会明确失败。不会将未知命令交给原生 ADB。此入口是协作工具接入层，不是阻止同一用户程序绕过原生 ADB 的系统沙箱。

默认会话模式是 control；纯截图脚本使用 `--mode view`，此时任何输入均被手机拒绝。多个任务不会抢占同一手机。入口每 1.5 秒发任务心跳，失联 8 秒后撤销任务；桌面轮询负责清理手机会话（通常再需一次 2 秒轮询）。工具退出或启动失败会立即尝试结束其拥有的会话，不影响随后新建的会话；桌面崩溃还有手机自己的心跳保护。手机暂停允许任务继续运行，但新输入立即失败，旧 generation 的请求在恢复后仍不能执行。

构建 `npm run build` 会生成本平台的 ADB 入口。Windows 使用系统 .NET Framework C# 编译器，无需额外包；CLI 安装时将入口从应用资源复制到用户 CLI 目录。macOS 文件保持可执行权限。桌面与手机 APK 均需更新后才支持完整 PNG 通路。

## 自动验证

```sh
node --test tests/phones.test.js tests/phone-response.test.js tests/phone-flow.test.js
node --test tests/adb-wrapper.test.js
node scripts/e2e-phones.mjs
```

控件与流程回归使用专用模拟器：先构建 `node scripts/build-phone.mjs --offline --instrumentation`，运行 `node scripts/e2e-phone-accessibility.mjs emulator-5584`；再在桌面中配对该测试模拟器并开启测试权限，运行 `node scripts/e2e-phone-flows.mjs emulator-5584`。模拟器 ID 必须替换为实际值。这两套脚本拒绝物理手机；后者通过真实 CLI、桌面服务和手机 App 执行流程，仅用 ADB 打开 debug 测试页。

2026-10-06 控件定位与流程新增能力已通过 46 项 Node/CLI/会话回归、Android 构建及 lint、API 30 模拟器上的 9 项无障碍测试和 4 项完整流程回归。RMX3700（Android 13/API 33）通过已安装的 CLI 连续执行两轮 26 步离线开发流程，执行阶段耗时分别为 4.649 秒、4.147 秒（不含安装、页面准备和会话申请/清理，不代表其他 App 的性能）。真机另验证断言失败、重名控件、禁用控件、等待超时、两端暂停后不再执行后续输入，暂停后不采集失败画面；全部会话结束后回到手机首页。证据保存在 `artifacts/phone-flows-20261006/`。Windows 已实测 UTF-8 BOM、中文路径及 PowerShell 安装入口；macOS 路径与执行方式做了代码检查，未做 macOS 硬件验收。

界面测试使用独立测试设备数据，不连接真实手机。真机验收需要检查：胶囊与通知显示；手机和电脑两端暂停/结束后输入被拒绝；锁屏、USB 拔插及服务退出后不会恢复旧指令。

2026-10-05 已在 Windows 与 realme RMX3700（Android 13）验证配对、三项权限、截图、页面快照、导航键、胶囊点按展开、两端暂停与结束、旧指令拒绝，以及八秒心跳过期后拒绝输入和恢复。短暂断线使用移除本应用的 ADB 转发连接模拟，重连后保持暂停。锁屏、物理 USB 拔插和 macOS 真机尚未验收；测试截图与心跳记录保存在 `artifacts/phone-control-20261005/`。

同日完成 ADB Wrapper：30 项手机/Wrapper 自动测试通过，另通过 CLI 安装、PowerShell、管理接口回归和手机工作区 UI 测试；Android 构建、5 项会话测试及 lint 通过。Windows 原生启动器验证了中文/空格/引号参数、二进制标准输出和退出码。真机通过原样 `adb` 命令获取 1240×2772 PNG；仅查看模式拒绝按键；手机 App 的暂停按钮能阻断后续 ADB 输入，恢复后旧 generation 仍被拒绝；点击、短滑动、最近应用/返回按键可执行。强制终止托管入口后，任务心跳过期结束手机会话，旧 lease 的输入被拒绝。已验证已安装的 `ppilot.ps1` 路径，并兼容 PowerShell 吞掉 `--` 分隔符的行为。证据位于 `artifacts/adb-wrapper-20261005/`；macOS/Linux 入口仅做了实现检查与环境构造测试，未做硬件验收。
