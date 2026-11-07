# Computer Use 持续迭代记录

本次工作由用户明确要求持续约 12 小时，多轮对比、学习借鉴、实现和验收。

- 开始：2026-10-29 15:17 UTC / 北京时间 10 月 29 日 23:17。
- 计划结束：2026-10-30 03:17 UTC / 北京时间 10 月 30 日 11:17 左右。
- 状态：进行中。上一轮完成不代表持续目标完成，不以单轮测试通过提前结束。
- 范围：ProfilePilot 本机 Computer Use；本机功能不依赖 ClipRelay。保留工作区原有其他改动，不自动发布或修改 README。
- 运行与验收：优先使用 ProfilePilot 自身控制入口；桌面测试串行进行；不绕过用户接管。修改后运行独立开发进程并确认其存活。

当前用户使用电脑的时间限制（优先遵守）：

- 用户在 2026-10-29 16:04 UTC / 北京时间 10 月 30 日 00:04 表示正在使用电脑，要求两小时后再进行可能冲突的验收。
- **2026-10-29 18:04:06 UTC / 北京时间 10 月 30 日 02:04:06 前，禁止 GUI 启动、截图/激活、鼠标或键盘验收，也不重启展示 App。** 继续代码、构建、静态审查与纯测试。当前桌面测试会话为空，所有自有夹具已清理。
- 所有协作者已收到限制。本机 `.tools/desktop-verification/acceptance-window.json` 记录门限，GUI 验收入口通过 `scripts/e2e/desktop-acceptance-window.mjs` 检查。届时仍须重新检查用户接管/会话占用，不能仅因到时间就覆盖控制权。
- 整体 12 小时目标继续，计划结束时间仍为北京时间 11:17 左右。

## 起点

上一轮调研记录为 [computer-use-review.md](computer-use-review.md)。本轮开始时应用可用，桌面控制会话为空；运行构建为 `c0f5f4495ecd74dca3933f5735235466a55356ecb6ca5339d96d390f86d8d3f2`。

已有能力：窗口枚举、UIA 观察、截图、键盘与常用鼠标动作、接管/停止、请求回执、取消与驱动退出确认。已有验证：23 项桌面专项单测和 18 项 WinForms 实机验收。

已知不足不能算作通过：真实非管理员应用曾出现 `DESKTOP_FOCUS_REQUIRED`；外部 Chromium 截图坐标映射不可用；异步应用操作尚无条件等待；多屏与混合 DPI 未实测；macOS 无原生驱动；旧版托盘右键曾结果未知。上轮真实夹具的权限是否代表正式应用，需要重新验证。

## 第 1 轮：真实运行条件与可靠性差距

开始：2026-10-29 15:18 UTC。

并行调查：

1. Windows 前台、完整性级别、UIPI、焦点诊断与窗口枚举质量。
2. 外部 Chromium 精确截图坐标：WGC、DWM 边框、Electron 捕获实现及打包成本。
3. 观察状态指纹、异步动作结果、UIA 缺口/取消与回执恢复的真实失败。

主任务：建立能体现实际 ProfilePilot 非管理员运行条件的验收入口，核对 baseline，安排串行桌面实验；根据具体证据选择实现，不先宣称普遍可控。

阶段证据：

- 已证实执行工具所在进程链为 High / elevated，实际 ProfilePilot App、helper、Explorer 为 Medium。不能把 High runner 的隔离夹具通过等同于实际 App 通过。
- 新增 `node scripts/verify-desktop.mjs --app`：通过桌面用户普通 token 启动自有 WinForms 夹具，所有操作走实际开发 App 的管理接口。
- 第一份真实 App baseline `.tools/desktop-verification/profilepilot-desktop-wgpoaT/report.json`：fixture 明确为非管理员；语义赋值/调用通过，第一处物理坐标点击返回 `DESKTOP_FOCUS_REQUIRED`。失败已记录，自己的测试会话与夹具已清理，没有重放。
- 调查发现 `set_value` 缺失 value 会被默认成空串，指针操作附带不支持字段可能被忽略。正补按动作严格校验，拒绝错误请求而不消耗观察或执行输入。
- 正补只读 `ppilot desktop doctor [--window ID]`，记录前台、目标与调用者完整性级别及有界激活的实际结果，不把所有输入失败笼统解释为 UIPI。

本轮复测与结论：

- 严格动作 schema、只读 `doctor`、DWM cloaked 窗口过滤、原生有界前台确认及错误诊断已完成；全量构建通过并以独立普通权限 App 进程运行（PID 28296，构建前缀 `d27a61c0`）。
- 同一真实 App 路径复测仍失败：`.tools/desktop-verification/profilepilot-desktop-wGKs1n/report.json`。helper 34876 与 fixture 27952 都为 Medium；前台为 Orca 23376。`SetForegroundWindow` 返回 false，369ms 内未确认，因此在派发物理输入前返回 `DESKTOP_FOCUS_REQUIRED`。不能把等待时间调整称作焦点问题已解决。
- 精确 PID 授权原型 `.tools/desktop-verification/pp-foreground-grant-BOy7UJ/report.json`：后台派生的 High 原型对实际 App 的 Medium helper 调用 `AllowSetForegroundWindow(28528)` 返回 false / LastError=5。没有使用 ASFW_ANY、模拟 ALT、提升 App 权限或授权失败后继续点击。结论是高完整性级别本身不提供前台资格；真正合法的前台授权入口仍待设计、实测。
- 修复 worker 停止屏障竞态：等待 helper A 退出期间，若 B 也进入停止，新的请求必须继续等 B；初始无屏障时不引入额外异步间隙。8 项 worker 测试通过。该修复晚于上述构建，等待下一轮 App 更新。
- 每次实际失败均清理了自己的会话和夹具，未重放未知输入；上述失败保留为验收证据。

## 第 2 轮：状态一致性、异步结果与固定截图后端

进行中。桌面实验仍串行，三个调查方向分别负责不同文件。

- 状态指纹：补 Value、只读、勾选、选择、展开状态，并要求输出与指纹使用同一采样。密码值不进入读取或散列。补遍历内部取消/预算检查；同步 provider 调用仍不能宣称有 4 秒硬上限。
- 新增 `ppilot desktop wait`：按 name/role/automationId/text/hasAction 的精确条件只读轮询，最长 20 秒，超时带最后观察和 `requiresObservation:true`；超时仍阻塞的读取会退役旧 helper，后续请求必须经过停止确认。用户接管/停止会取消等待，不重放动作。9 项专项单测通过，真实 App 验收待执行。
- 新建普通权限状态夹具 `scripts/verify-desktop-state.mjs`，通过独立于 ProfilePilot 的夹具命令制造外部状态变化，以验证旧引用拒绝、重新观察恢复，以及异步 UIA Invoke 后等待结果。
- WGC 固定后端原型编译成功，正在普通权限自有 Electron 窗口上验证。尚未取得可采信的帧，坐标输入仍明确关闭；不能把编译通过称作坐标映射可用。

本轮真实复测（截至 2026-10-29 16:00 UTC / 北京时间 10 月 30 日 00:00）：

- 状态夹具首次发现回归：UIA 对不支持的 availability 返回 `AutomationElement.NotSupported`，并非 bool false；错误分类为 unavailable 会阻止所有普通控件操作。失败报告 `pp-desktop-state-hM0DU2` 已保留。修复只将该明确 sentinel 解释为官方默认 false，真实异常/错误类型仍 fail-closed；18 个纯原生检查通过。
- `pp-desktop-state-UmKo6O/report.json` 通过 9 项实际 App 验收：密码值隐藏、外部 value/readOnly/toggle/selection/expanded 变化拒绝旧 ref、刷新后编辑成功、异步 Invoke 结果等待、超时后新观察。夹具非管理员，单屏 120 DPI；异步等待 5 次观察、1346ms。App 独立 PID 30632，构建 `f905ce8ff7e10c18…`；测试后会话为空、夹具关闭。
- wait 又发现事件循环超时边界：已完成 read 的微任务可能先于过期 timer。新增派发前/匹配后的单调时钟比较，超过期限不得作为匹配成功；10 项 wait 测试通过。
- 新增只读 `receipt --session TASK --request-id UUID`，可在任务结束后查询 pending/succeeded/failed，不触发动作或续租；缺失回执不表示未执行。修复 BUSY 在派发前被永久缓存。6 项回执测试通过。
- WGC 普通权限矩阵 `profilepilot-wgc-Iwtha7/report.json` 17 项通过，9 张实际图涵盖普通/菜单/缩放/移动/最大化/恢复/遮挡/无框/保护解除，其他病例明确取消、超时、保护、隐藏、最小化、关闭。此前外部前台变化造成失败的 `uKxtnk` 报告保留。单屏 125%，最大颜色中心映射误差 1.525 物理像素；不代表多屏、HDR 或混合 DPI。1ms 超时实际约 29ms，说明同步初始化仍需外层进程硬期限。生产坐标授权仍关闭。
- 额外 `--focus-before-input` 实验表明 UIA SetFocus 成功也未使窗口成为前台，随后物理点击仍在输入前被拒绝。
- 尝试官方 Computer Use 准备自有夹具前台，仅完成模块初始化；两次 `list_windows` 均返回 native pipe 不存在，未执行任何 UI 操作。已释放自己的会话并关闭夹具。此失败不作为 ProfilePilot 输入通过的依据。

## 第 3 轮：截图生产接入与输入冲突诊断

进行中：WGC 使用固定官方 NuGet metadata 的构建路径、旧 Windows 类型隔离；原生输入前按键/鼠标捕获冲突检查的独立模块；只读 helper 故障与动作未知结果的语义审查。功能集成后仍需普通权限实际 App 验收，不改变前台权限或用户接管要求。

不干扰用户的离线进展：

- WGC 已接入原生 Chromium 窗口截图分支，并跳过 Electron 的再次捕获。仍返回 `coordinateInputAvailable:false`，候选边界只用于诊断。纯测试发现 unsupported 状态名错配，已修成明确三项白名单；保护、关闭、变化、超时、取消等失败不得降级。5 组测试包含 14 组原生纯校验通过，最新生产路径尚未实机复测。
- 固定官方 Windows SDK Contracts 10.0.19041.2 的包及三个 WinMD 散列，构建只提取白名单 metadata，校验缓存；非 Windows 无下载或编译。8 项构建依赖测试通过，原生 helper 可离线重复构建。
- 新增输入初始状态检查，检查已按下的键、鼠标捕获、移动/缩放模式及读取条件。29 个纯检查通过。仅能证明初始条件；不宣称已经完成物理人工输入自动接管，实际运行仍待验收。
- worker 的 UTF-8 帧长度、重复/错误 ID、无 pending 帧、退出与流关闭顺序、停止屏障和同步写异常得到补强。只读中断改为 `DESKTOP_READ_INTERRUPTED`，可准备新 driver 等待明确新读取；不自动重试、不续租、不交还用户控制。动作仍保留未知结果语义。
- 原生响应按实际 UTF-8 字节限制，成功帧含 CRLF 不超过 3.5 MiB，错误帧不超过 16 KiB。动作已经可能执行时编码失败仍是未知结果。17 项纯协议检查通过，包括真实内存 JPEG 与中文/控制字符边界；未运行 GUI。
- 桌面入口增加跨 browser/Electron 的 PID 关联与占用检查，主动会话、用户接管、parked 均不能被桌面入口绕过。模块与传输适配首批 31 项、服务层相关 51 项纯测试通过。检查并非跨服务原子锁，仍需缩小采样时差并验证实际接入。
- 准入审查发现原有 Profile 进程扫描存在吞错返回空集合的路径。不能把 UI 容错结果当作完整空闲证明，正增加只供控制准入使用的严格读取路径，普通界面的容错行为保持独立。
- 原生输入审查发现长读取后缺少临近取消检查，以及零插入的按下仍登记释放、释放失败诊断丢失的问题。取消检查已补；输入/释放账本经 18 项纯 fake 检查后已接入，保留原始失败和独立清理结果，不为明确零插入的 down 制造 up。[SendInput 官方返回值与状态约定](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) 是判断依据；成功插入释放并不证明已处理或已物理松开。没有在用户使用时注入输入。
- 增补导航键 extended 标志及重复组合键拒绝，依据 [KEYBDINPUT 约定](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)。文本/组合键每次输入前重新核对同一控件焦点，避免只确认顶层窗口而继续输入到同窗口其他控件。真实事件行为与耗时待普通权限夹具验证。
- 跨入口准入改为先发现进程关联，再读取 Gateway/扩展控制状态；控制快照单独限制为 2.5 秒，原映射时间戳不刷新。新纯测试证明旧并行方式可读到过早的空闲状态，两阶段能读到等待期间新出现的 owner；最后采样到派发之间仍不是原子锁。重复 resume 一个 active 会话改为只读，不打断在途动作。
- 分发审查纯复现两处缓存完整性缺陷：损坏构建 EXE 只凭输入摘要仍报 ready，损坏 runtime 副本仅凭文件名被复用。已增加构建产物摘要核验；runtime 复用前核对内容，损坏副本保留并原子发布独立修复副本。36 项 worker/构建缓存测试、8 项 SDK 测试及 TypeScript 检查通过。Windows 的六个源文件、EXE/许可资源路径、manifest 覆盖完整；macOS 分支跳过 Windows metadata/编译/打包。未生成或运行真实安装包。
- 窗口枚举现区分主动截断与 EnumWindows 本身失败，失败不会伪装成完整空列表；读取当前 helper 会话 ID 只做一次，避免逐窗口创建 Process 对象。参考 [EnumWindows 返回值契约](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)。
- 严格采集入口已完成：`getStateForControlAdmission()` 不更新展示缓存、不做维护，复用同一进程/TCP证据；坏行、扫描警告和必要关联失败返回未知。允许受保护非浏览器进程没有命令行、PID 0、未安装 Chrome 时缺少 Local State；修正 isolated Default 误映射为 native Default，兼容旧 lsof 的隐式 `f` 字段。20 项新模拟测试加 2 项快照缓存测试通过，普通权限本机采集仍待验证。
- 2026-10-29 17:04 UTC 后完成整合构建，构建前缀 `92abe5fdbbadec8f`。17 个相关测试文件共 **177 个 Node 测试通过**，其中原生测试组另执行状态/键包 23、输入状态 29、输入账本 18、协议 17、WGC 14 项内部纯检查。没有运行全量含真实 hook 的 `npm test`，没有启动展示 App；不能将该离线结果称作本机物理输入通过。
- 新键盘夹具脚本准备了中文/emoji、导航事件、重复/不支持键拒绝后 version 复用、同窗口首字转焦停止输入。仅通过语法与 C# 编译，`guiStarted:false`。后续入口为 `node scripts/verify-desktop-keyboard.mjs`，必须经过本机验收时间门限。

以上修改尚未重启到展示 App；当前进程继续保持原构建。到用户允许的验收时段再统一构建、以独立普通权限进程启动，并按真实 App 路径复测。

## 第 4 轮：人工输入暂停的准备与物理坐标校验

2026-10-29 17:22 UTC 起，仍处于用户使用电脑的延迟验收时段。本轮未启动 GUI、截图、hook 或注入输入。

- 新增纯 `DesktopInputObserver`：浏览器 PID 订阅与桌面观察分开，匹配 helper epoch / generation 的确认后才 ready；物理输入、未知注入、断线及协议故障锁存暂停，重连不自动恢复桌面。22 项纯测试通过。没有生产入口接线，不能据此宣称人工输入自动接管已启用。
- 为后续观察补齐非零 64 位输入标记：App worker 生成稳定十六进制标记，原生启动参数严格校验，在最终 SendInput 派发处写入鼠标/键盘各自的 ExtraInfo；滚轮、Unicode 与异常清理的释放均覆盖。标记只是辨别本程序注入的线索，不是认证凭据。旧 App 无启动参数时仍可使用原生 helper，但其随机标记不能被未来观察器自动信任。
- 纯指针转换模块按 [Microsoft WPF 像素中心方法](https://source.dot.net/UIAutomationClientSideProviders/MS/Internal/AutomationProxies/Input.cs.html) 准备绝对输入，使用 64 位中间值，拒绝越界与超过 32768 像素的虚拟跨度。12 项检查包含 480,192 个模型点的往返校验；模型通过不代表真实多屏验收。
- 原生鼠标移动改为带标记的 SendInput，移除 SetCursorPos。检查虚拟桌面范围、实际显示器区域和处理后的光标位置；不在显示器上的点不让系统自行钳制到其他位置。无法建立 PMv2 物理坐标环境时禁用鼠标输入与截图坐标授权。App 捕获适配保留原生返回的 false，不再重新授权。真实移动、拖动和混合 DPI 尚待时段开放后测试。
- 共享原生源文件清单覆盖生产构建及所有整合测试，避免加入第七个源文件后测试继续编译旧驱动；反复检查窗口进程身份时及时释放 Process 资源。
- 标记/worker/观察状态机/坐标专项运行共 59 个 Node 测试通过；接入绝对移动后的原生状态、输入状态、协议、WGC 与构建缓存 11 个 Node 测试通过，其中内部状态/键包检查增至 26 项。原生 helper 编译成功；当前展示 App 未重启，仍不能作为更新后实机通过证据。
- 跨入口准入反例证明：某个已知 PID 的高权限 Chrome 命令行不可读会误拦无关窗口。正将这一特定缺口及其关联影响范围记录到完整进程采集中；Local State、文件锁扫描、未知应用候选等无法界定的缺口继续全局拒绝，不因可用性要求吞错。
- 已核实产品正常路径目前只有主 App 创建一套浏览器 Input Guard；Gateway/独立浏览器服务不创建它。但另建独立桌面低级 hook 仍可能与浏览器的阻断行为互相遮蔽。下一步先做共享 broker 的 fake 传输/生命周期验证，再接原生事件。微软 [LowLevelMouseProc](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc) 还建议纯监测场景考虑 Raw Input；本轮记录为替代方案，尚未证明其在触摸键盘、RDP 和合成输入下的覆盖，不据此作保证。

后续离线审查：

- 限定缺口实现完成：`controlDiscovery` 携带同次采集 UUID、原始时间戳、完整 PID 集合及缺口影响集合；浏览器祖先/后代依赖一并保守纳入。缺元数据、未观测目标、任一时间戳过期、未解析 owner 或后续全局采集失败仍拒绝。79 项相关纯测试通过；无 PID 创建身份贯通或跨服务原子租约保证。
- 纯 mock 又复现 owned Chromium compositor 回退会重新授权原生 false。已增加独立 `physicalPixelsAvailable`，只有明确物理坐标且 crop 为有限、正尺寸并完整包含于窗口时才授权；字段缺失也不授权。7 项 WGC/图像测试组通过。
- `doctor --window` 增加只读准入结果及 gaps，不接管、不暂停、不续租；provider 错误保留 unknown 而不转发原始错误文本。12 项服务准入测试通过，TypeScript 全项目检查通过。
- 主物理输入验收脚本补 70 秒 CLI 子进程期限，以及彼此独立的会话/服务/夹具清理，清理结果写入最终报告后才输出成功。仅解析检查，未启动脚本进行桌面验收。
- PrintWindow 现在在捕获前、绘制后及编码后核查窗口/客户区、可见/最小化/遮蔽、DPI 和显示保护状态；未知保护查询仍明确是 unknown，不能称作未保护。12 项纯 C# 守卫检查通过；普通权限、仅针对自有窗口的捕获异常矩阵已编译准备，尚未运行。
- 新 `WindowsInputBroker` 只通过注入的 fake transport 验证订阅、ARM 确认、UTF-8 分帧、背压、退出确认和迟到消息。与纯观察器共 54 项测试通过；缺管道和同 helper 旧 generation 的畸形消息反例也已补。没有生产接线，不启动原生监听器。
- 鼠标与键盘实机夹具已增加目标控件 `GetMessageExtraInfo()` 聚合检查，记录事件种类、64 位标记和计数；零标记的合成移动只归为来源未确定。编译及脚本纯检查通过，真实标记传递尚待实际 App 验收。
- 本轮整合 `npm run build` 成功，构建前缀 **`47f801246ff967ed`**。截图守卫/图像/原生状态/输入账本/观察器/broker 合计 64 个相关 Node 测试通过；插件 17 文件一致性、键盘 compile-only 和 WGC check-only 通过。展示 App 未重启；新原生监听 helper 仍在另行离线准备，不包含在已启用功能内。

## 第 5 轮：普通权限实际接入与采集故障

门限开放前最后核查（2026-10-29 18:02 UTC）：

- 当前 App 已由此前记录的 PID 30632 变为 PID 1604，后者启动时间 16:36:12 UTC、构建前缀 `b65c3a4a172d4f16`；本轮延迟验收期间 root 没有启动它。后续必须重新核对实际 PID、路径、构建与占用，不能沿用旧 PID。只读检查显示 28 个任务均未运行、桌面会话为空；默认浏览器保持用户所有权，没有接管它。
- 服务层另一个反例已复现：截图坐标权限为缺失、null 或字符串时，原先 `!== false` 会放行。已改为只接受布尔 `true`，4 个权限病例及控制/图像/回执共 42 项纯测试通过；整合构建 **`83ac97bd40b94bdc`** 成功。
- 状态验收脚本增加 70 秒 CLI 期限与独立的会话/夹具清理；自有进程清理等待退出确认，不能只依据终止请求已发送就标为清理成功。脚本仅做语法检查，尚未运行 GUI。

门限开放后（18:04 UTC 起 / 北京时间 02:04 起）：

- 18:04:23 UTC 开始更新空闲开发 App，核对旧 PID、仓库路径、无运行任务、桌面无会话后停止旧进程。通过 Explorer 普通 token 独立启动，新 PID **42624**，构建 **`83ac97bd40b94bdc`**，启动器结束后仍存活。没有接管默认浏览器。
- 普通权限状态夹具 `pp-desktop-state-QFp13c/report.json` 在 claim 阶段失败，尚未进行任何语义或物理动作。准入 gaps 为 `apps:unresolved_process`、`catalog:provider_failed`；会话为空，夹具已确认退出。正在修复证据采集，不关闭准入检查来通过测试。
- 目录采集纯测试没有覆盖真实 Windows PowerShell 编译，实机暴露 `const bool Strict` 的不可达分支警告被 Add-Type 当作错误；已改为 `static readonly`。随后三个自有文件复现批量路径被 `@($json | ConvertFrom-Json)` 嵌套成单个数组，再转成一个空格连接字符串，导致 RM 29/6 错误；已用直接赋值保留单独路径。新增真实 Restart Manager 检查：三个自有文件中仅保持打开的一项识别到测试进程，其他两项为空；两种 strict 模式通过。未读取文件内容或改变浏览器文件。
- Restart Manager 的 session key 改用按 [RmStartSession 官方输出缓冲区契约](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmstartsession) 分配的 33 字符 StringBuilder，零容量 RmGetList 用 null。原生失败保留 START/REGISTER/LIST 与数字错误码，供 doctor 返回明确缺口；不把失败解释为空闲。
- 应用关联的只读诊断发现：ClipRelay 的 UI runtime 没有 PID，但 fresh Gateway 已有对应实际 PID；另一条无进程 identity 的 attach 登记 ZCode 当前无监听端口。修复将使用明确的 PID/端口/采样证据限定缺口，不改变 UI unknown 为 stopped，也不重新连接这些应用。仍在实现和纯测。
- 原生截图矩阵 `pp-desktop-capture-zrFCaq/report.json` 前五项通过：正常图片、隐藏/最小化/保护拒绝、恢复后新图。`resize-during-print` 用例未取得预期拒绝，但此前 printCount 始终为 0，尚无实际触发变更的证据；该失败不能直接认定守卫漏检。夹具已确认退出，正在补充真实触发和后状态证据。此矩阵是普通权限生产源码整合，不是 App/CLI 接入通过。
- 公共验收 CLI 运行器增加绝对期限、有界 UTF-8 输出、超时未知结果语义，以及缺失管道/迟到错误清理；状态、键盘、鼠标和 WGC 脚本共用。4 项 fake 子进程检查通过，包括 kill 无 close 时仍进入独立清理；没有自动重试动作。
- 新共享原生输入 helper 仅编译与纯测试通过，仍未接入产品。观察器信任标记改为当前 child epoch、匹配 ARM ACK 后建立；新 child 或未确认 ARM 的标记不能沿用旧信任。broker/observer/native 共 60 项 Node 测试（内部另含 30 项 C#检查）通过；真实 hook 生命周期与输入投递尚待串行验收。

本轮实际复测与限定结论（截至 18:42 UTC / 北京时间 02:42）：

- 应用准入修复已完成：只读 OS 进程/TCP 快照和新鲜 Gateway 证据共同限定应用缺口；关联 PID 仍受占用规则约束。无已知进程身份的 attach 登记仅在相关端口确实没有监听、没有 owner/连接冲突时不影响无关目标；UI runtime 的 unknown 保持不变。新增按 appId 返回静态诊断原因，不输出配置路径、命令或 owner 内容。64 项准入相关纯测试通过。
- 再次独立启动普通权限 App，PID **15972**、构建 **`1452bda6f9a2163389933c27c8b5b81d83a8d9f2885a1c674e228618681b8777`**，启动器结束后仍存活。此前 70b97/116306 构建的准入失败报告保留，不算通过。
- 实际 App 状态矩阵 **`pp-desktop-state-EFtvEz/report.json`** 9 项通过；普通权限夹具、单屏 120 DPI、准入 gaps 为空。状态变化后的旧引用拒绝、密码遗漏、异步 Invoke 与等待超时后的新观察均通过。会话为空，夹具确认退出。
- 实际 App WGC **`pp-desktop-wgc-XqMQ9I/report.json`** 4 项通过：UIA 与截图、仅图片、被遮挡、无框。实际 JPEG 标记和候选几何已检查；坐标输入仍为 false。没有证明多屏、HDR 或混合 DPI。前台未被截图改变，清理确认。
- 实际 App 键盘 **`pp-desktop-keyboard-oeNKSK/report.json`** 在首个 type_text 之前被 `DESKTOP_INPUT_STATE_UNKNOWN` 拒绝：当前前台仍是 High Orca，Medium helper 无法取得其完整性信息，gap 为 IntegrityUnknown。UIA Focus 成功不代表顶层取得前台。夹具两个文本框均为空，注入标记事件数为 0；没有输入成功的证据，没有重放。
- 原生观察器生命周期 **`pp-input-observer-lifecycle-gdko03/report.json`** 5 项通过：ARM/DISARM/新 generation/QUIT、armed EOF、startup EOF，以及 stdout 堵塞时 QUIT/EOF。协调器及 child 都为 Medium；退出均确认、没有 kill fallback。此检查不注入输入，也不证明真实人工输入投递；helper 仍未接入产品。
- 普通权限原生捕获矩阵 **`pp-desktop-capture-WEUTmX/report.json`** 保留 partial：正常/隐藏/最小化/保护/恢复 5 项通过，外部定时器确实改变尺寸时被 `CAPTURE_WINDOW_CHANGED` 拒绝，最后恢复后新图通过。PrintWindow 回调未触发，明确列为未覆盖；不能把概率性几何压力测试称作所有时序通过。这是原生源码整合，不是 App/CLI 验收。
- 前台调研确认：管理员身份不自动提供 `AllowSetForegroundWindow` 资格；`AttachThreadInput` 会共享并重置键盘状态，还可能和目标队列一起阻塞。[Microsoft API](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput)、[队列阻塞说明](https://devblogs.microsoft.com/oldnewthing/20080801-00/?p=21393/) 支持保持生产拒绝。Windows-MCP 的 ASFW_ANY/Attach 方案、UFO/pywinauto 的 UIA Focus 均不能作为本场景已验证的解决方案。后续只为自有夹具设计显式测试前台准备，并报告 `productAutonomousActivationProven:false`。

## 第 6 轮：输入监听接入前的投递验证与恢复边界

18:42 UTC 起。继续约 12 小时目标。先验证自有标记/未知注入/浏览器几何，准备共享 broker 的浏览器适配及桌面生命周期接线；尚未启用共享监听器，不把纯协议测试称为人工输入自动接管。

- 适配层又发现一处 `!== false`：普通窗口截图会将缺失/null/字符串坐标权限升级为 true，绕过服务层此前的严格判断。新反例先失败，已改为仅接受布尔 true；截图/控制/回执 42 项测试通过，尚未更新实际 App。
- 标记投递第一次无辅助运行 **`pp-input-markers-DZqsS9/report.json`** 在 `owned_window_not_foreground` 停止；Medium 夹具未取得前台，hook child 数 0，三种标记 down/up 均为 0。已确认清理，未重试或把它列为投递通过。
- 桌面 worker 的部分管道缺失反例先失败：若 spawn 只缺 stdout，剩下 stdin/stderr 的迟到 error 会成为未处理异常。处理器现提前安装到所有已存在管道；相关 worker/observer 分发 40 项检查通过。没有运行真实 hook。
- 为后续分发准备输入监听器的 Windows 构建、字节核验缓存及惰性 spawn 工厂；和桌面驱动共用经验证的运行副本发布逻辑。编译失败保留最后完整产物，损坏运行缓存另建副本，macOS 不编译/启动 Windows helper。当前仅准备并编译，尚未加入默认 build、打包清单或 main 接线。

18:49–19:02 UTC 的下一组反例与准备：

- 通过 `ppilot desktop` 读取实际 App 自身窗口，产物 **`own-ui-1452.jpg` / `own-ui-1452.json`**：WGC 返回 1402×951 的标题栏与空白内容，UIA 仅 14 项 Pane/系统按钮。此前 `workspace.ready` 日志的 bridge/shell/navigation/ready 全 true，标题也已由工作区 JS 设置；因此后台接口成功、页面初始化成功均不能代替展示验收。会话已完成。正比较默认渲染节流、遮挡、新 DOM 内容及初次绘制顺序，没有把原因先归为 WGC 或 UI 故障。
- 新的显式 `--assisted-foreground` 仅给自有临时夹具准备前台，准备器继承当前 runner 的实际 token，不请求提权、不改变其他窗口。按 exe/PID/startticks/HWND/pad/nonce 核对输入区域，检查前台与目标 capture/move-size/held keys/DPI；一次 move/down/up 后必须有夹具同标记 down/up 回执、前台确认与 TopMost 撤回。报告保留 `assistedForeground:true` 和 `productAutonomousActivationProven:false`。42 条纯断言、2 项 Node 测试及编译通过，尚未实际输入。
- 新 `WindowsBrowserInputGuard` 适配器沿用旧点击配对规则，broker 对每个 epoch 的实际 PID 保护证据单独确认；全局 activeCount 不能代替子订阅证据。SET 确认有界，失败后才重试；浏览器退订不卸载桌面监听。main 仍未启用。旧 Input Guard 三项解析/健康/点击纯回归通过，macOS native 启动流程未改变。
- broker + fake streams 反例证明 ACK 返回后，同一 chunk 的后续人工输入已可能将当前状态暂停；服务必须重读当前 snapshot。另一个反例证明旧实现先 DISARM 再 ARM 会丢掉换代时的旧 generation 输入。本轮补 **REARM**：同一 native hook 线程检查前驱仍 active 且未 latch，原子登记后继标记；此前已观察到输入就向后继明确拒绝，此后输入归后继。TS 在过渡期也接受前驱活动并同步暂停后继，不降级为无条件 ARM。
- REARM 未确认时的新 ARM 不再静默替换它；返回 BUSY，调用者必须处理原过渡。连续换代、同 chunk ACK/活动、旧活动/故障、新标记信任及浏览器适配合计 **86 项 Node 测试通过**，内部另含 **35 项纯 C# 检查**。不证明真实硬件投递，也不证明低级 hook 不会被 Windows 静默移除。
- Windows observer 已加入默认编译、Windows 打包资源和构建摘要清单，macOS 跳过 Windows 编译；仅完成本机编译，未发布安装包，运行 App 尚未更新/启用。native 源码摘要此时为 `f367e5b5764241571db7f6b4b5156765998867710017164681873cd9bf099a77`。

## 第 7 轮：首次绘制、真实消息标记与共享观察器接线

2026-10-29 19:00–19:17 UTC，仍在约 12 小时目标内，未完成最终交付：

- 当前实际开发 App 仍为普通权限 PID 15972、构建 `1452bda6f9a21633…`。`pp-desktop-wgc-Q7qgVl/report.json` 的 **16 次 WGC 像素核对通过**，包括默认后台节流、direct/iframe、遮挡中多次 DOM revision 与 `capturePage` 对照。每次核对实际标记位置；不把帧时间戳递增当作 DOM 新鲜度证明，仍不授予坐标输入权限。
- 实际 App 主窗口最大化/恢复均通过 `ppilot desktop` 原生 UIA Invoke 执行，窗口由 1418 宽变为 1938 后恢复到 `[260,35,1418,959]`；`own-ui-f3091c38-66c6-4e24-8cc5-75467963559b-report.json` 确认恢复和会话结束。前后 WGC 图像仍为空白客户区，不能交付为“已展示正常”。
- 新 `pp-desktop-wgc-A0v4hd/report.json` 首次加载即遮挡的 direct/iframe 共 **8 次截图全部未证明当前 DOM**：每个变体图片摘要不变，三个标记均缺失；DOM revision 和 timers 递增、rAF 只有 0/1；两次自有 `capturePage` 均返回 `UnknownVizError`。自有 cover 关闭后仍 `visibilityState:hidden`；当时其他前台窗口覆盖整屏，所以不能把关闭 cover 当作目标实际可见。夹具/会话均确认清理，下一步增加自有窗口短暂置顶但不激活的恢复对照。
- 辅助前台准备实际失败两次：`pp-desktop-keyboard-PUfdfv`、新增取证的 `pp-desktop-keyboard-39mUvg` 均未继续任何产品键盘动作。后者发送 `b96f3696666dc676`，x64 测试窗口的 `GetMessageExtraInfo()` 实际 down/up 均为 `00000000666dc676`；窗口取得前台、TopMost 已撤回。证据只说明这个 WM 消息路径保留了低 32 位，未证明因果是跨完整性级别，也不涉及 LL hook 的完整标记。
- 辅助准备专用标记改为非零随机 32 位，仍按完整 16hex 精确相等，保留 nonce/PID/startticks/HWND 等约束。专项 WM 计数独立记录原值及 exact64/zero-extended-low32 匹配方式；只有预设低 32 位非零互异才能使用后者。生产 LL hook 与真实 observer 专项继续比较完整 64 位。3 项纯测试含 57 条 C# 断言通过，相关夹具离线编译通过；新的实机键盘验收正在运行，尚无通过结论。
- 增加 `WindowsInputRuntime`，将主 App 的浏览器适配器和桌面服务绑定到同一个惰性 broker；缺观察器不开放桌面 claim。退出阶段顺序释放桌面、overlay，再等待 broker 子进程确认退出，前一项失败仍尝试后续清理。5 项 fake transport 集成测试通过：惰性启动、单桌面绑定、detach 取消 ARM、共享进程保留浏览器保护、关闭等待与清理顺序。
- 新 native helper 与兼容 PowerShell helper 同用固定 `Local\\ProfilePilot.InputObserver` 存在式 mutex；冲突、不可访问或同名异类对象都不开 hook，持有者句柄到进程退出才由 OS 释放，不终止别的 App。3 组原生/兼容独立进程竞争及同名 event 冲突测试通过；测试使用隔离名称且只验证同一 runner 完整性级别，未冒充跨权限实际 hook 测试。兼容脚本也在 reader 前建立消息队列，避免早 EOF/QUIT 丢失。
- 当前旧 preview App PID 19340 的默认 helper 路径指向同 checkout 的 `native/input-guard-win.ps1`，下次懒启动会读取更新脚本；不能假定它永久缓存旧 PS。环境变量覆盖及已经运行的旧未加锁 helper 仍需区别。Electron 单实例锁按 userData 隔离，`runtime-state.json` 的 PID 不能证明唯一 App 所有权，更不能据此关闭其他实例。
- 新 observer 源码摘要 `5864fe88e94e52289432b91c476386080937ef98435d6637aaa816f7bfe8e5b6`，离线编译及 35 条 C# 协议检查通过。完整 TypeScript 检查通过。以上主程序接线尚未构建进正在运行的 `1452…` App。

第 7 轮后续实测与改动（至 19:30 UTC）：

- `pp-desktop-keyboard-MvgS3t` 的辅助准备成功，实际 App `1452…` 完成 Unicode/emoji/组合字符、导航编辑、三类无效按键拒绝等 **5 项检查**。随后确定性焦点切换反例失败：首字符 `A` 的 TextChanged 将焦点转到第二输入框，第二字符空格仍送达该输入框；产品随后正确返回 `DESKTOP_OUTCOME_UNKNOWN / DESKTOP_FOCUS_CHANGED` 并暂停。保留此失败，不以“已暂停”掩盖输入已越过目标。
- 公开 Win32 契约没有通用“目标已处理字符”的确认屏障；`SendInput` 仅确认插入，`SendMessage(WM_NULL)` 和 `WaitForInputIdle` 不能作为排队输入完成证据。因此本轮对每个完整 Unicode scalar 的 up 后加入约 10ms 可取消让步，持续检查原生焦点 HWND 与 UIA 焦点，并检查最后一个 scalar；这是降低竞态概率，不能保证延迟异步焦点切换永不溢出。物理 `type_text` 每次上限改为 **512 UTF-16 单元**并拒绝未配对代理项，防止持续让步必然超出 worker 的有界请求期限；`set_value` 仍为 16384，无隐式语义替换。新实际 App 键盘回归正在运行。
- 原生 marker 初次实测 `ZPZIep/31k3xO`：完整 64 位键盘的 own/foreign、暂停锁定、旧标记保留已通过；随后 mouse 的 LL hook 实际收到 `000000009012ef01` 而非发送的 `c33456789012ef01`，说明本机路径截掉高位，不能继续将同一完整键盘标记直接用于鼠标分类。
- 生产发送与两层观察器改为按输入种类精确匹配：键盘保留完整 64 位；鼠标明确发送非零 32 位别名（源标记低 32 位非零时取低位，否则取高位）。只有 ARM 确认的对应种类标记才被忽略，接收端不把任意高位不同值截短后信任。旧别名按 epoch 保留，新 child 清空。标记不是认证；外部注入若在 OS 截断后恰好同别名，无法仅由此字段区分。
- 随后 `rPqCou/FYUXrs` 暴露第二个实际问题：125% DPI 下 pointer 坐标正确，但 hook 输出窗口矩形为 `[513,261,510,294]`，实际为 `[641,326,638,367]`。一次启动线程 DPI 设置不足以覆盖回调上下文；已将每次回调内的 hit test/矩形查询包进明确 PMv2 上下文，调用其他 hook 前恢复原上下文。
- 修复后 `pp-input-markers-yyV1n6` 完整通过，追加真实 REARM 病例的 `pp-input-markers-19QhHe` 也通过：**9 项检查**，含已锁定前驱拒绝 REARM、连续 REARM 保留旧标记/忽略旧 stop；125% 物理矩形和 down/up 坐标精确相同，浏览器守卫拦截的鼠标消息未送达夹具。两 helper 均 Medium8192，真实退出码0，无 kill fallback，夹具/children 确认清理。全部输入为合成注入；未覆盖物理硬件，也不是实际 Chrome 页面事件验收。
- 新 `pp-desktop-wgc-BVMuX6` 保留 **8 次启动遮挡失败 + 4 次显露恢复成功**。临时置顶且不激活后，direct/iframe 的 revision1/2 都匹配实际像素，rAF 恢复、visibility 变 visible，前台 HWND 前后均 4261434，原层级恢复。实际 App 随后 `own-ui-3e9024ac-b54c-4b83-baa2-cf669cf7587c` 只读截图显示完整 Windows 桌面页、UIA59，actions为空，session已清理。无需修改 CSS；外部 Chromium 初次未绘制时的空帧仍是明确限制。
- observer/native/driver/服务组合专项合计 **113 项相关测试通过**，内含原生 observer43项、desktop-state27项。新增真实服务→runtime→broker→状态机的7个内存组合反例也通过；没有以纯测试冒充真实硬件证据。
- 完整 `npm run build` 成功，构建 **`6f0a7c72e3e4ebdbe2c0c5de4771489fe4a86011a036027fe9b094025b86ef84`**；observer源码 `c3804e87227450ce9986d5c87e766bddce41953165ea36b97bfb68d48c6474dd`。Windows构建摘要另覆盖兼容PS文件。确认旧15972无活动会话、28项任务无运行/排队、无现存guard后，仅更新该自有开发实例；新 **PID36540** 在 `19:29:10.154Z` 由 Explorer 普通token独立启动，启动器结束后确认存活。未停止 PID19340。新 App `desktop status` 已报告 `inputObservation.available:true, phase:idle`，本轮开始实测共享观察器的生产接线。

## 第 8 轮：实际接管、进程退出确认与状态显示

2026-10-29 19:30 UTC 起，约 12 小时目标继续，未到最终交付：

- `6f0…` 普通权限实际 App 的 `pp-desktop-keyboard-QmMpeY/report.json` **7 项通过**，包括 Unicode/emoji/组合字符、导航编辑、三类无效按键、确定性焦点切换后第二框保持空白，以及未知结果回执。`pp-desktop-state-hdIl0T/report.json` **9 项通过**。两者均使用已启用共享观察器的真实 App，夹具退出、会话为空。焦点让步仍仅降低竞态，不保证任意延迟异步切换永不溢出。
- `own-ui-a15adf51-48f4-40e0-917c-69278db3f830` 只读截图正常，UIA56，未执行输入。但追加 `own-ui-6cc57dbf-484b-45a7-b609-ff69bd306993` 在约14秒内三次看到后台 active/ready，页面仍未显示会话。后台节流是待核实原因；不能把接口状态当作 UI 已更新。增加状态主动推送及异步读取版本检查，防止旧 active 回包覆盖刚到的 takeover/stop；五项纯测试覆盖通知、乱序、旧错误、卸载和独立控制条。
- 两个关闭流程反例证明旧 helper 仍活着时也可能报告 clean。现 DesktopWorker.close 返回并缓存退出确认 Promise；同步撤销控制、取消请求，等待退出，失败不能当作成功。服务追踪全部已替换 catalog/owner，ARM/REARM 前等待旧驱动退出并复核当前会话；迟到 exit 可用于明确恢复，原失败仍保留到 shutdown。关闭相关 **148 项纯测试**及 TypeScript 检查通过，实际 App 更新验证待继续。
- 完整指针矩阵的 `profilepilot-desktop-JEaRG2`、`profilepilot-desktop-xl2CB8` 均在辅助准备命中检查停止，产品输入为零。后者记录父窗 SetWindowPos 返回成功但未获实际 TopMost；撤回父窗 TopMost 又把已存在的 owned popup 降级。保留失败证据，调整为准备成功后才创建弹窗。
- 下一次 `profilepilot-desktop-ZsSMRR` 准备已成功：自有 pad 的一次 move/down/up、同标记回执、前台和层级恢复均确认。但原本设置 NoActivate 的 WinForms popup 显示后却成为前台，严格断言再次停止，产品输入仍为零。继续检查 managed Show/TopMost 路径，未放宽前台断言。
- 新实际 App 接管脚本 `verify-desktop-takeover.mjs` 已编译，32 项 C# 纯检查及6项 JS 完整 mock 流程通过。将以自有夹具一次 foreign-marker F24 验证暂停与明确恢复；不增加第二套 hook、不冒充人工硬件输入。准备完成不等于实跑通过。

第 8 轮实跑与后续修复（至 19:54 UTC）：

- 构建 **`94430564b818f06af3187b8b9dcb38f65ad4718690f744a28d49b5703d79d11e`** 已独立启动，普通权限 **PID43212**，启动时间 `19:46:29.951Z`，启动器结束后存活且 Responding=true。此前36540经身份/空会话/无活动任务/无guard核实后停止；19340未动。
- `pp-desktop-takeover-IogkWb/report.json` **4 项真实 App 检查通过**：own type_text不暂停；自有夹具一次 synthetic foreign64 F24 pair后App报告 external_input/observed paused；新UIA写入拒绝且文本/事件未变、旧receipt仍可读；明确测试恢复得到新generation/epoch，fresh observe后own输入成功。WM实际marker为exact64，App公开status不回传触发marker，因此仍是受控时段关联证据，不是独立App marker回报，更不是物理硬件测试。session为空，fixture退出有回执。
- `profilepilot-desktop-7RKUat/report.json` **19 项通过但总体失败**：全部鼠标键型/拖拽/双轴滚轮、真实像素移动、拖拽按下后接管释放、非激活popup、键盘、UIA截断与6次延迟采样已过；最后新driver拒绝旧观察返回 `DESKTOP_FRESH_OBSERVATION_REQUIRED`，CLI错误归类exit1而非约定75。保留失败报告。新增纯反例先失败，再补 fresh-observation-required / observer-pending 的75映射，34项CLI/控制测试通过；未重放旧操作。
- popup修复实跑确认 managed TopMost=false、native TopMost/NoActivate=true，主窗仍为前台。原 WinForms `TopMost=true` 路径会主动聚焦；本机 .NET4.8 IL 和[官方 Form 源码](https://github.com/dotnet/winforms/blob/main/src/System.Windows.Forms/System/Windows/Forms/Form.cs)核对后，改为 CreateParams 初始原生样式，无额外强制激活。仅夹具改动。
- 两次新 App 只读 UI 检查 `own-ui-3828781a…` / `own-ui-16f0ce55…` 仍只有14项外框UIA，初次被遮挡的内容未绘制；workspace.ready四项均true，不能代替展示证据。状态push实机效果因此仍待内容绘制后验收，准备Windows首帧启动修复。
- 关闭复核另发现已确认退出但stop曾失败的旧driver引用积累；最小清理后40次故障/迟到退出样本集合归零，failureCount40与最多32条失败样本仍保留，shutdown仍失败。关闭相关153项纯测通过。750ms尝试kill、1500ms未确认失败仅是worker尝试预算；共享observer后续清理另计，事件循环也可能延迟，不能宣称整个App固定1.5秒关闭。

第 8 轮主窗与状态显示复验（19:55 UTC）：

- Windows 主窗现在在原本应显示的条件下先隐藏，等待 `ready-to-show` 再显示；5秒超时有诊断，显式show/Mini/hide/close/quit/实例替换撤销迟到自动显示。background/smoke/mac条件保持，23项纯生命周期/实际main接线测试通过。保持默认 paintWhenInitiallyHidden，不修改全局后台节流。
- 控制条IPC新增12项可信文档/顶层frame/工作区订阅/关闭竞态纯测试，加状态feed5项共17项通过。旧窗口的延迟load回调不影响替换实例，已销毁notice不阻断清理，快捷键注销会被独立尝试。
- 完整构建 **`e9d9cc3f71bfdff58a2cd6df83da41a053b9cfea7e198eac9ad8438e32e0ff7d`**，普通权限独立 **PID2240**，启动 `19:55:00.220Z`。本次 `workspace.first_paint_ready` 等待180ms后show，日志当时mainFrameLoading仍true，明确不代表全部iframe加载完成。
- `own-ui-bf2d5b12-f074-4245-9f16-ae7220ea49d8-report.json` **严格显示断言通过**：首次和后续截图均UIA59，三次实际页面读取均含当前session与“正在控制”；WGC截图已人工视觉核对为完整Windows桌面控制台，没有临时置顶/激活/窗口动作，actions为空，session清理确认。此前两份14项UIA报告只表示采集成功，不算展示通过。此结果限本次本机启动，不推广为外部Chromium所有遮挡场景保证。
- 完整指针矩阵正使用新构建再次运行；另开始分析2.4秒左右截图固定开销。High runner单独新鲜Windows OS扫描3次约744/673/679ms，仅为旁证，不能当作Medium App耗时归因或直接相加。

第 8 轮最终矩阵结果：

- `profilepilot-desktop-eSFZi7/report.json` **20 项通过**，运行 App e9d9/PID2240；本次包括最后的 handoff/resume、旧观察拒绝和清理。三次 image-only约2447/2597/2518ms，UIA272项+图片约3928/4048/4264ms，均保留children_limit/uia_skipped的真实范围。单屏120DPI、辅助前台准备，不证明自主激活、多屏或macOS。所有自有会话/夹具确认清理。
- `own-ui-controls-429a24fb-fb04-4fc4-9631-a18de23ef9db-report.json` **3 项实际 App UI 检查通过**：当前页面新鲜UIA“接管”按钮调用后owner暂停并继续占用、后续observe拒绝；明确测试恢复后新鲜“停止”按钮结束会话。两次Invoke取消了正在执行自身的driver，正确保留OUTCOME_UNKNOWN而不重放，最终后台状态确认效果。没有绕过暂停去读UI，也不声称物理键鼠测试。

## 第 9 轮：异常顺序、跨入口竞态与准入开销

2026-10-29 20:00 UTC 起，继续长期目标：

- 给未确认退出的桌面worker补结构化停止证据：自有PID、exit_timeout/kill_rejected/kill_error/process_error、是否尝试/接受kill、取消管道写失败，以及白名单格式OS错误码；不转发原始路径或异常文本。52项worker/关闭纯测试与TypeScript检查通过，运行App尚未重建包含此诊断。
- `.tools/desktop-verification/admission-race-audit.json` 纯组合复现了跨入口竞态：真实DesktopService/evaluator采到available后，真实GatewayControlPlane可先acquire并授权发送，桌面仍基于旧采样派发一次fake action；下一次observe才发现occupied并暂停。桌面paused owner也未阻止Gateway新owner。无网络/GUI/真实输入。现有控制快照并非原子reservation，单例hook也不约束CDP/UIA授权重叠；重复status或只给App加队列不能解决。完整方案需Gateway、Electron、native service与扩展权威owner共同参与PID+启动身份+会话范围reservation、代际凭证和未确认释放恢复。本轮不以局部锁伪称已修复，限制继续保留。
- 准入开销纯计数确认：同轮catalog与appsControl各一次force OS scan；LocalApps.list可能另触发扫描/HTTP。strict profile reader还执行准入未消费的shellIntegration、头像、展示名/路径评分及external /json/version。准备独立control-admission DTO省去展示工作，保留必要CDP identity/占用过滤、strict失败和原始采样时间；暂不同时改共享快照语义。
- `pp-desktop-observer-fault-iOx2uS/report.json` 隔离普通权限Electron生产Service/Runtime/Worker故障实跑 **总体失败**，尚不计通过。私有nonce验证精确自有helper身份/父PID/startticks/hash/Medium、唯一owner/epoch及零browser订阅后，只终止该child。实际先pipe失联并paused/disconnected/unknown，再于下一毫秒出现exit；脚本错误地只接受helper_exited且要求exit先于pause。产品及时撤销控制，脚本正在增加真实stream-first与exit-first证据匹配，不要求产品延迟暂停。所有自有Electron/WinForms/driver/helper退出确认，用户App2240保持idle；这不是主App完整main或人工硬件验收。

- `pp-desktop-observer-fault-oKiOzw/report.json` 修正证据匹配后 **3 项实跑通过**：隔离普通权限生产服务的自有 observer 收到 stdout:end（sequence9），随后 paused/disconnected/unknown（10），最终 exit（15）/close（16）。旧 UIA 写入拒绝且夹具内容/输入回执不变，历史 receipt 可读；等待后没有重启或 ARM。两个 driver、observer、孤立 Electron 与 WinForms 均确认退出。匹配器只接受实际 broker 对应的失联来源，不接受物理接管、无来源暂停或 stdout:close 单独证明退出；12 项纯检查另覆盖 exit-first。真实主 App2240保持idle，此结果不冒充完整main的故障验收。

第 9 轮续（20:15–20:21 UTC）：

- 新连续会话脚本旧App基线 `pp-desktop-cycles-rtm4jb/report.json` **7轮完成、总体失败**：每轮新claim/只读UIA/图片/结束后，owner驱动和observer消失，只保留同一catalog PID39940；前6轮App handles988，第7轮995。第8轮claim因 `PROFILE_FILE_PROCESS_CHANGED` / stale_discovery 被拒绝，未重试，会话/夹具已清理。UIA约2574–2721ms、图片2368–2620ms。内存采样包含App其他工作和GC，不能据此宣称无泄漏。该初版缺每个native child字节摘要；记录只作操作/时间基线，不能单凭App buildId证明所有helper字节。
- 验收复核发现最后status与complete间的接管可被普通complete结束。新增可选 `complete --require-active`：服务同步校验当前owner及observer后结束，无中间await；已暂停保持占用并拒绝，release仍可明确清理。5项专项反例通过，包括未送达服务回调的observer暂停和取消活跃挂起read。不保证尚未送达Node的OS输入已被观测。连续脚本同时修正关闭回执失败跳过fallback、正常退役采样消失误报，补CLI/实际native路径及hash。
- 专用准入DTO完成：省去Shell、头像、展示名/路径及external展示URL探测，保留严格进程/文件/连接证据和原采样时间。98项关联纯测通过；root另复核49项通过。尚未更新App测量实际收益。后续共享OS查询必须是同一发现轮次，不能套用按完成时计时的显示缓存；纯实验发现旧catalog pending与新apps采样可错轮、LocalApps配置变更后可返回旧列表，待单独修复。
- native锁失败新增同步flush的严格startup-failure，183/5/其他分别映射占用/访问失败/建立失败，首个诊断保留到stopped。starting阶段exit先到允许有界读取stdout尾部，但禁止ready/SET/ARM；ready阶段退出仍立即暂停。174项相关纯测含44项C#协议检查通过；实际固定锁竞争尚待新构建。新增stdout:close可触发disconnected，故障证据匹配器随生产契约更新，依然必须有独立process exit，管道关闭不能证明进程退出。
- 纯对象50k轮保留堆约：observer历史8.24MiB、runtime失败启动11.42MiB、已结束会话5.10MiB；释放对象后基本可回收。未把这归为不可回收驱动泄漏，未增加任意终身次数上限。减少冗余身份存储和签发序号/高水位是后续候选，不能截断集合而重新接受旧身份。

第 9 轮新版实跑（20:21–20:26 UTC）：

- 完整构建 **`1acb0a8ea03d826724b4bd43b35519fdb94fe291644f96c51ad43e1b5788ced4`** 成功；284项组合纯测试通过。确认2240身份、空会话、28任务无活动、无observer后仅更新该开发实例，独立普通权限 **PID11668**，`startedAt=2026-10-29T20:21:31.479Z`，启动器结束后仍Responding。PID19340保持运行。observer源码`03d4959aa01069b39724bd58f9a62372b9e767485c20c412fa56374969f1cff2`，exe摘要`7f77f82dbdea66333b7a948f11cb7a5f66a1a17cf008347e216399e8fbcae3a7`。
- `pp-desktop-cycles-a9L3UG/report.json` **20轮通过**，采用条件完成、精确进程身份和实际native路径/hash；每轮owner+observer退役，catalog单独保留，最终sessionnull、夹具原进程退出。App handles在首次活动后约970，后续约960–973；不等价于长期无泄漏。非激活自有WinForms、零input动作，无物理硬件或多屏结论。
- `.tools/desktop-verification/admission-dto-cycle-comparison.json` 保留观察性对照：旧版7个完成样本中位claim2502.66/UIA2634.23/image2420.98ms；新版20样本2417.14/2494.22/2342.59ms。不是交错A/B，旧运行总体失败且缺每child摘要，存在重启/后台/GC等差异，**不能据此宣称稳定因果提速比例**。
- `pp-desktop-takeover-qF1hQI/report.json` **5项实际App通过**，追加已验证外部合成F24暂停后 `complete --require-active` 返回75/USER_IN_CONTROL并保留同一paused owner/generation/epoch，未改变夹具文本与事件；之后仅按已有明确合成验收范围恢复并fresh observe。自有fixture原输入及foreign释放有回执，最终会话/夹具清理确认；仍不是人工硬件输入验收。

第9轮启动冲突与连续运行补充（20:27–20:37 UTC）：

- `pp-observer-startup-8trEYV/report.json` 与 `pp-observer-startup-Dt7NbW/report.json` 均通过实际 App 验收：独立 Medium 持有者分别占用固定 `Local\ProfilePilot.InputObserver` Mutex、创建同名 Event；实际 native 返回 Win32 183 / 6，CLI 分别返回实例占用 / 启动失败，保留 paused owner、拒绝继续观察、不自动恢复。自有持有者通过 nonce 正常关闭并确认原进程退出后，新会话成功 claim/observe/条件完成。原生路径及字节摘要与 `1acb` 构建一致，所有自有 fixture 清理确认。权限拒绝 5 仍只有纯测试，不能推为实机通过。
- `runtime-generation-heap-20261029/comparison.json` 固定同一依赖、只替换 runtime 类的纯对象测量：50,000 次失败启动，保留 JS 堆由 12,023,984 降至 10,708,792 bytes，减少约 1.25 MiB；删除 binding 的重复历史，broker 的 generation/epoch 历史仍完整保留。detach 期间保留占用直到同步清理完成，旧 binding 不能影响后继。4 个旧源码反例先红后绿；不等同于真实 App 原生内存下降。
- 第二批 Windows 准入优化：catalog、LocalApps 与 appsControl 共用独立采样，保留查询开始时间及 snapshotId，冻结自有证据；两分支都结束前不发起下一轮，单源失败不另扫补证。严格 LocalApps 列表在配置替换后拒绝结果，macOS 保留原入口。实际源码纯集成确认每轮 1 次 CIM / 1 次 netstat，失败不回退展示缓存。采样之后的变化和跨入口 acquire 仍非原子 reservation。
- 暂停说明按真实原因显示：占用未知、观察器中断、操作结果未知等不再都记为用户接管。自动提示条失败不覆盖已有接管原因，也不续租已有暂停；迟到的失败先检查租约，防止复活已过期会话。工具条错误绑定当前控制身份，后继会话不显示旧错误。合并关联纯测试 286 项通过，工具条新增错误/原因清除反例另 6 项通过；这些新改动仍待下一构建和实机布局验收。

第9轮共用采样实机结果（20:35–20:46 UTC）：

- 完整构建 `9c22a59620a456fbf0ba128a1778d490a2fd065fdae4ad090ce30b9237f18caf` 成功；确认旧实例 idle、任务无活动、精确 PID/启动时间及 helper 身份后，独立启动普通权限 App **PID4116**（`2026-10-29T20:35:27.576Z`），原预览实例19340保留。当前 native 桌面/observer 字节与上一构建相同。
- 首跑 `pp-desktop-cycles-WYnUXg/report.json` **总体失败**：第一轮 claim/observe/image 成功，之后进程采样命令失败，旧脚本漏存采样器 stdout 的结构化错误。自有会话、窗口和 owner/observer 均清理确认；无法从现有报告追溯具体采样失败原因。已补 `sampleFailure` 和失败时控制状态，不把这一轮丢弃或计入成功率。
- 复跑 `pp-desktop-cycles-osSX0B/report.json` **20轮通过**，每轮结束仅同一 catalog helper，最终 sessionnull、fixture 原进程退出；App 最后957 handles。与上一构建20轮的顺序同机对照保存在 `admission-shared-sample-comparison.json`：claim/UIA/image 中位数从2417.14/2494.22/2342.59降到2262.95/2363.69/2211.13ms；新 P95 为2408.47/2505.81/2409.43ms。不是交错A/B或稳定因果提速比，第一轮采样失败另行保留。
- `own-ui-b59f5060-40e8-482e-b0ba-30d1dabb8fdb-report.json` 通过真实 App 状态显示及截图检查，UIA59，截图已视觉核对，actions为空、无临时激活/置顶，结束会话为空。
- `profilepilot-desktop-6AHKri/report.json` **20项实际 App 输入矩阵通过**；272节点 UIA+图片3次约3711/3745/3670ms，image-only约2242/2261/2269ms。`pp-desktop-takeover-mHF4eR/report.json` **5项通过**，包括外部合成F24触发暂停、拒绝暂停后的写入和条件完成、显式验收恢复后更换generation。两者均已清理；仍为辅助前台准备、单屏120DPI，不能称自主前台或人工硬件接管通过。
- 只读 Medium 原生微测 `uia-cache-review-20261029/medium-d899086399f1165fab1a76c62a9ac039.result.json` 调用原桌面组件 `IsInteractiveDesktop` 共1110次，全部true，1000次批耗时4.17ms。它不测UIA provider或整次观察；没有据此移除控制检查。另发现恰好耗尽文本预算后 Document 文本可被静默省略，准备独立修复缺口报告。

## 第10轮：控制提示条就绪、布局和采样证据

2026-10-29 20:47 UTC 起：

- 独立布局夹具先失败 `pp-toolbar-layout-VGUQqm`：Electron 的默认应用通过 ESM import 加载 CJS，`require.main === module` 未命中，未产生 ready。未开始 claim，超时后精确原进程强制清理；报告保留失败。入口改为 Electron browser进程及精确 argv 文件校验，增加 nonce/PID 绑定的启动阶段诊断；初始化异常退出并写 failure。
- `pp-toolbar-layout-UPS3EV` 确认窗口正常启动并正常退出，但暴露了夹具的尺寸假设错误：请求390×200，实际 contentBounds 与 DOM viewport 均为376×194、DPR1.25。改用真实内容区检查布局，保留请求值与实际值，不调整测试窗口来掩盖溢出。
- `pp-toolbar-layout-JM2cjp` 完成6种状态截图，最长暂停说明+48px错误时 documentHeight205超出viewport194，整体验收失败。收紧提示条内边距和段落间距后，`pp-toolbar-layout-9u4sDY` **6种状态通过**，最拥挤时按钮底部180.8px、文档高度194px；截图已视觉核对。错误在恢复/新owner/idle时清除，fixture通过nonce正常退出。展示暂停由独立fixture模拟，实际App owner全程active；没有绕过实际暂停去截图，也没有真实输入动作。
- 页面错误提示另去掉 Electron IPC 包装，保留实际失败内容；工具条错误归属和迟到失败纯测试6项通过。新 UIA 文本预算修复有先红后绿：8×4096恰好耗尽后，有TextPattern的Document标记 `text_limit`；不探测密码、不改State完整性或动作fingerprint。30项原生纯检查、组合40项测试通过；这些源码等待下一轮构建。
- 进程采样只读复现30次，其中3次 `CHILD_PATH_UNAVAILABLE`。加结构化子PID/创建时间/句柄证据后又读30次，确认1次短命 PowerShell 在WMI枚举后退出（OpenProcess87加独立PID不存在证据），标为 `SAMPLE_UNSTABLE`。仅这种确定变化可重读，权限/存活但路径缺失仍失败；保留前32条不稳定证据及总计数。7项纯分类检查已放进长期测试目录。不能据此回填此前WYnUXg的未知具体原因。
- 真实 DesktopService 与 fake Electron 的4个纯反例在 `notice-failure-audit.json`：构造/同步加载异常可留下arming；同步加载失败后可复用空白控制条恢复；show失败或永久pending仍能允许动作。正实现可取消的提示条准备门槛和明确生命周期；尚未完成或宣称实机通过。
- 跨入口 reservation 仍未实现；完整入口、权威边界与故障恢复设计见 [设计记录](desktop-control-reservation-design.md)。现有 admission 快照不能作为原子控制排他承诺。

第10轮后续（21:07 UTC 起）：

- 新5轮循环 `pp-desktop-cycles-WJ4Uhu` 在第一次 claim 前失败，实际原因是 `PROFILE_FILE_SCAN_LIST_FAILED_234`，不是进程采样器错误；没有创建 owner 或发送输入，清理确认。Windows Restart Manager 每次 `RmGetList` 会刷新列表，首次容量可能不足。[微软示例](https://learn.microsoft.com/en-us/windows/win32/rstmgr/using-restart-manager-with-a-secondary-installer)明确要求有界重读。
- 在实际嵌入 C# reader 上注入可增长的列表响应，旧两次读取版本两种strict模式均失败；改为同一RM会话内最多4次读取，仅重试234，不改变整个发现轮的原采样时间。不采用234携带的部分行，拒绝无效/不完整计数、无效PID和超过16384项的容量；权限等其他错误不重试，持续增长仍unknown。两种模式各17条纯检查及真实3个自有文件的空/占用映射测试通过。红绿记录 `restart-manager-growth-20261029/{red,green}.json`；实际App尚未更新含该修正。
- 第三批准入展示成本精简：仅admission路径跳过canonical会话档案补全与活动记录的仓库git信息补全，保留原session/PID/port/TTL与所有占用合并。Windows/macOS模拟反例先红后绿，97项相关纯测试通过；合成计数git6→0、档案枚举2→0，基础OS/context/activity读取次数与三态决策一致。不是实际耗时测量，默认UI展示路径保持。
- WGC成功响应补回已经读取的 `captureState`，包含实际affinity返回值/Win32错误、DPI与几何，不新增查询，也不开放坐标输入。8项相关测试通过，内含15条WGC纯检查；新构建后可直接经ppilot读取普通Chromium的保护状态证据。显式屏幕区域捕获仍仅在独立原型阶段：限定所选客户区直接BitBlt，说明可能包含遮挡；不作为WGC失败后的自动回退，也不授予坐标输入。
- wait审查发现新的纯反例：无pending read的interval超时后仍接受历史version动作；不可用空值与截断前缀可被当作精确文本匹配。修正正在进行，将按字段完整性判断已找到控件，树范围截断不一概否定正向匹配；尚未合并或实机通过。
- 提示条准备机制与文档握手已完成：同顶层WebContents、文档nonce及本代generation的render ACK，加load完成和显示确认，全部成立后才ARM；复用窗口每代重新确认。loading仍能停止/接管，旧/failed窗口不能恢复控制。139项纯测试通过；真实Electron资源缺失/JS异常/无ACK专项尚待运行。
- 状态验收夹具升级为nonce、PID/startticks/HWND绑定，增加心跳、正常退出回执和原进程句柄确认，强制清理会保留失败。默认仅编译，`node scripts/verify-desktop-state.mjs --run` 才运行GUI；新增实机长name/长value/空值/interval超时检查已编译，等待新构建，尚未计通过。

## 第11轮：合并构建与真实生命周期复验

2026-10-29 21:22 UTC 起：

- 合并notice文档握手、wait字段完整性/全部超时失效、第三批准入展示成本精简、Restart Manager234有界重读及WGC captureState。303项相关测试通过，完整 `npm run build` 成功；构建 `ab6477fa20c0d7565b60e4949dec0df937ba17b67569e47f2b90fe24cfa00f5b`，CLI摘要 `b6df4caf93e552d997b9e2cd8e8694fd31e802b60e40ab07afdbfb391c109bfc`。
- 核对自有旧App4116的精确启动身份、空桌面会话、28项任务无运行/排队、无observer后更新。新普通权限开发App **PID37128** 由Explorer独立启动，`startedAt=2026-10-29T21:22:00.140Z`，OS startticks `639289057199149254`，启动器退出后存活且Responding=true。旧catalog39696已退出，另一个preview实例19340未停止。
- 状态夹具新13项验收已开始，尚无通过结论。真实Electron提示条故障夹具与显式屏幕区域原型仍独立开发，所有GUI由root串行运行。

第11轮实机发现（21:23 UTC 起）：

- `pp-desktop-state-OXZOQg` 前10项通过但总体失败：已有9项状态检查与新增长name513→512、拒绝截断name精确匹配、完整sibling仍能匹配已通过；4097字符Value预期返回4096前缀，实际只有2000。会话为空，nonce关闭回执与原进程退出均确认，不能把前10项当全矩阵通过。
- `pp-desktop-state-8AbRr7` 独立长度诊断：请求/夹具真实Text.Length/返回分别为1999/1999/1999、2000/2000/2000、2001/2001/2000、4097/4097/2000。后两项仍 `textStatus:readable`、`truncatedFields:[]`、`state.valueStatus:readable`、gaps为空；控件同时提供set_value和text模式。该报告 `ok:true` 仅表示诊断完成，不代表长文本行为正确。
- `pp-desktop-state-iNj1Sr` 进一步用夹具自身SHA256确认前2000个X+A变成同前缀+B；旧观察ref的set_value竟返回executed:true，后续观察也确认为覆盖值。`staleSuffixProbe.regressionReproduced:true`，证明Value摘要缺失后缀会漏检旧引用。输入仅作用于自有夹具，正常清理；正在设计同时约束显示/精确匹配与状态指纹的修正。
- 微软 [WindowsEditBox 源码](https://raw.githubusercontent.com/dotnet/wpf/main/src/Microsoft.DotNet.Wpf/src/UIAutomation/UIAutomationClientSideProviders/MS/Internal/AutomationProxies/WindowsEditBox.cs)说明Value pattern的Text路径限2000，Text pattern另有路径。本机Framework4.8.9363.0 `UIAutomationClientSideProviders.dll` 只读IL亦确认 `GetValue→Text→ProxyGetText(hwnd,2000)`，SHA256 `0614acbbb974514f33bc86d9e2c2ef8a0b25630dcb531aeea135cb420bfaa06a`。有界GetText只约束返回量，不保证provider内部读取有界，worker硬期限仍须保留；不使用会SetFocus的range移动方法探长度。
- `pp-notice-runtime-lmVFyV` 独立真实Electron的首次render ACK、load、非激活可见确认93.28ms已成立，但主App claim因 `PROFILE_FILE_PROCESS_CHANGED` 拒绝，未创建控制owner或发送输入；整个矩阵仍失败，夹具正常退出。正在使用全新发现轮重新执行，没有把旧采样重标新时间或忽略unknown。

第11轮独立提示条与捕获原型（21:30–21:36 UTC）：

- `pp-notice-runtime-coW31V/report.json` **6种启动/复用情况通过**：真实生产notice类、sandbox preload与复制公共资源在普通权限独立Electron运行，首次ready92.90ms、同文档新generation4.65ms；缺JS70.35ms被撤销，无ACK5026.98ms和脚本初始throw5018.86ms由5秒门槛拒绝。实际App37128只读claim/observe/WGC截图/条件完成，图片已视觉核对，最终sessionnull、fixture正常退出。这证明独立真实notice生命周期，fixture没有真实Service/observer/driver/hooks，不冒充完整App故障链。
- 进一步 `pp-notice-runtime-r5vsbJ/report.json` **真实反例失败**：两个窗口先成功ready，再分别在页面主世界异步throw与Promise.reject；faultFired均true，2509/2528ms后依然ready、没有authority撤销或unavailable消息。隔离preload的error监听未收到主世界错误；正在加只允许撤权的窄桥接。实际App仅idle预检，无claim/截图/输入，fixture43384通过nonce正常退出。首轮启动通过不能覆盖这个已就绪后失败缺口。
- 独立屏幕客户区原型 `pp-desktop-screen-region-9mFKir` 只诊断完成：普通权限Chromium窗口并非layered，affinity0、DWM开启、DPI120、客户区1000×658；前台仍是另一个窗口，因此不具备采样条件。`pp-desktop-screen-region-I2TUaE` 正式尝试亦因foreground_required **拒绝捕获**，没有生成图片，两次均正常清理。这只验证资格拒绝，不代表捕获功能通过；原型未接入产品，也不授予坐标输入。
- 2000字符问题的源码修复已通过96项关联纯测（含41组native检查）：保留raw Value语义，仅恰好2000时补有界TextPattern完整证据，Observe与Validate0一致；补充证据缺失/不一致/达到16385上限时拒绝控件动作，显示与wait报告不完整。已扩展实机矩阵覆盖真2000、后缀变化和16384/16385边界，待统一构建。此修复针对已证Framework边界，不能声称任意provider静默截断都被识别。

## 第12轮：长文本身份与提示条运行中异常

2026-10-29 21:38 UTC 起：

- 171项组合纯测试通过，完整构建 `c9bd9862aa18ba5f3b80ffebe1d9046f4fc25eb66119810b87a8e32eba834b8f` 成功，native desktop摘要 `fbb2d0b50b4cd3278844085b1f1d9ebf1b32fe21f858c216ae3e8ecdba997a13`。确认旧App37128空会话、28任务无活动、无observer及精确原身份后更新；新独立普通权限 **PID40584**，`startedAt=2026-10-29T21:38:27.107Z`，OS startticks `639289067068843897`。启动器结束后仍Responding，预览19340保留。
- `pp-desktop-state-VRwS4h/report.json` **16项实际App通过**。4097字符经TextPattern显示4096并标截断，不匹配截断前缀；真2000字符确认后仍可精确匹配；相同2000前缀+A改为+B后旧ref返回 `DESKTOP_ELEMENT_CHANGED`，外部修改保留。16384字符完整取证允许fresh edit，16385达到证据界限返回 `DESKTOP_ELEMENT_UNAVAILABLE`，夹具长度/hash证明未改写。空文本成功匹配；单次读取后interval超时3211ms，旧Invoke被 `DESKTOP_FRESH_OBSERVATION_REQUIRED` 拒绝且保存次数不变，fresh observe后恢复正常操作。nonce夹具2684正常退出、sessionnull。
- `pp-notice-runtime-CIumdI/report.json` **2项运行中异常实跑通过**：真实页面先ready，再主世界throw/未处理Promise拒绝，31.0/42.2ms后document authority撤销、自动销毁、回调将fixture状态paused。只允许当前nonce撤权的窄桥接生效；没有真实Service/observer/hooks，实际App只idle预检，不冒充完整App控制故障链。正常清理，无强制结束。
- `pp-notice-runtime-fvh5K0/report.json` **启动/复用6项再次通过**，首次ready101.7ms、复用4.2ms；完整替换成坏脚本使listener未安装时，仍由无ACK的5秒门槛拒绝。实际App读取正常条的WGC图片已视觉核对，正常退役，无输入。`pp-desktop-cycles-qAioRp/report.json` **新构建5轮通过**，UIA约2274–2343ms、图片2096–2512ms；每轮owner与observer退出，最后仅catalog helper，sessionnull、自有fixture正常退出。不是长期泄漏结论。
- 下一批准入诊断准备仍不改变unknown拒绝。只读审查发现Restart Manager已有创建时间但当前映射丢弃，仅按PID加入；[微软RM_UNIQUE_PROCESS契约](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ns-restartmanager-rm_unique_process)明确PID+创建时间才是身份。不能直接把CIM时间当精确FILETIME：[CIM_DATETIME](https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime)的小数域为微秒，本机40584的CIM ticks `639289067068843890` 与原进程ticks `639289067068843897` 实差7个100ns tick。当前未改身份协议，也未声称消除PID复用竞态。

第12轮后续（21:44–21:50 UTC）：

- `pp-desktop-screen-region-Fk4j6H` 在新鲜observe中未找到nonce按钮，未发focus；原harness丢失完整观察，不能推断缺失原因。修后失败前即保留完整观察、首次绘制时序及accessibility状态。`pp-desktop-screen-region-0DqlXd` 显式给自有测试Electron开启accessibility，17个UIA节点含唯一按钮，真实App `focus` 一次返回executed:true，但实际前台前后仍是HWND656964。条件完成成功、所有自有会话/进程正常退出；屏幕客户区捕获因非前台拒绝，没有图片。这证明本次UIA焦点动作未带来前台激活，不证明普通Chromium默认可访问，也不计捕获功能通过。
- root审查纠正了原型验收路径：focus准备失败、用户接管或动作未知后，不得继续通过独立原型截图；五个组合纯反例先红后绿，之后实跑Fk4j6H确实仅初始diagnose。原型仍未进入产品。
- `own-ui-06bf75bd-93a1-48d2-a660-86d23233564e-report.json` 实际App40584页面检查通过，前后UIA均59，三次轮询可见当前owner标签；WGC画面已视觉核对，actions为空、条件完成后sessionnull，没有临时置顶或激活。
- `restart-manager-identity-20261029/report.json` 只读原型提取实际C#列表reader，仅打开自有文件，三次RM创建时间均精确等于原进程GetProcess.StartTime；CIM相差3个100ns tick。该runner是High，明确不作为普通权限验收；没有GUI/输入或生产身份逻辑变化。

## 第13轮：发现失败诊断、能力查询与原生对话框

2026-10-29 21:51 UTC 起：

- 保留 `PROFILE_FILE_PROCESS_CHANGED` 的原错误语义，补充 Windows Restart Manager、POSIX lsof 与运行时进程合并三个阶段的白名单诊断。仅携带当前失败的来源、阶段、缺失 PID、查询数量和已存在的采样元数据；不补造时间、不以旧成功采样代替当前失败，也不放宽 unknown 准入。
- 首次组合测试156项中1项失败：旧测试loader将新纯模块替换为空对象，造成 `readProfileProcessChangeError is not a function`。构建虽随后完成，未立即更新运行实例；修正3处测试loader后同组合 **156/156通过**，再更新App。失败与修正输出分别保留在 `integrated-process-diagnostic-text-capability-rerun.tap` 和 `integrated-process-diagnostic-loader-fixed.tap`，不能把第一次计为通过。
- 构建 `7721e68997f1abad6879f47b6587df6a0ba47bd157fdff8cb12925307e8d155d`；新普通权限独立App **PID40068**，`startedAt=2026-10-29T21:54:12.529Z`，OS startticks `639289076523041619`。启动器退出后仍响应，预览19340保留。
- `wait --has-action text` 现在接受可读文本能力，但 `action kind=text` 仍是非法输入类型。`pp-desktop-state-5cVIRV/report.json` **2项实际App通过**：TextPattern能力匹配；非法action返回 `DESKTOP_INVALID_ARGUMENTS` 且夹具值未变。夹具41632正常退出、sessionnull。
- 修正验收进程检查方法：缓存native可执行文件实际位于 `%TEMP%/profilepilot-{desktop,input-observer}-runtime/<sha256>.exe`，此前按固定 `ProfilePilot.InputObserver.exe` 名称筛选不能证明没有observer。21:54重新按缓存目录、父进程和可执行路径核查，仅catalog34512归属于40068，无observer或旧App遗留native子进程。旧记录中的“无observer”应以此补充核查为准；后续更新使用真实缓存路径身份。
- 开始实际原生 `IFileOpenDialog` 的 Cancel/Open 矩阵。夹具通过新鲜UIA Invoke打开同步模态对话框，只允许自有nonce文件，禁用最近文件记录并使用独立client GUID；动作未知即停止，不重放或自动恢复。尚未计通过。

第13轮实际反例（21:57–22:01 UTC）：

- `pp-desktop-dialogs-qnz3z7/report.json` 真实UIA Invoke已打开原生模态窗（约7101ms），精确选择后旧父窗引用返回 `DESKTOP_OBSERVATION_STALE`，Cancel Invoke成功且回执为正确取消HRESULT、父窗已恢复enabled。但夹具自身 `ClearClientData` 抛COMException，整轮失败；没有进入Open或自动重试，正常关闭夹具42900且sessionnull。正在按官方调用顺序与精确HRESULT诊断夹具清理。
- `pp-desktop-cycles-KaDDMc/report.json` 请求50轮，**前17轮通过，第18轮observe失败，整体不通过**。诊断明确为 `windows_rm_pid_join`，缺失PID21824、原采样523进程、snapshotId `a45d4897-3532-4d77-94b7-1f07f5b61fc7`、capturedAt `1793311249431`。产品进入 `control_state_unknown` 暂停，没有自动恢复；root随后只读查询该PID已不存在，不能倒推其当时身份。夹具41880正常退出、owner/observer退出、暖catalog34512保留。
- 这17轮UIA约2269–2573ms，图片约2059–2394ms；App句柄基线961，末次清理971。私有字节150364160→188657664，包含App其他后台活动与GC，短样本不足以判断泄漏。采样两次遇到瞬时ADB/PowerShell子进程，只有确认其已退出才重采；未将访问失败当退出。循环harness现补完整build/token绑定及先等待正常退出，任何强制清理fallback均判失败。
- 下一小批窗口目录增加 `enabled`、`minimized`、`ownerNativeHandle` 只读状态，采样后复核目标身份。依据 [GetWindow GW_OWNER](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindow) 与 [IsWindowEnabled](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindowenabled)；owner关系不等于modal或控制权限，不自动选择窗口。47项相关纯测试和TypeScript检查通过，尚未构建或实际验收。

第13轮提示条完整链路与新目录构建（22:01–22:05 UTC）：

- `pp-desktop-notice-chain-yg1plN`（throw）与 `pp-desktop-notice-chain-DYJt1Q`（Promise rejection）各 **3项通过**。隔离普通权限Electron运行真实 `registerDesktop`、默认DesktopWorker、WindowsInputRuntime及原生observer；先实际set_value，再对已ready的自有提示条主世界注入一次异常。实际服务以 `notice_unavailable` 暂停，owner驱动和observer正常退出；旧ref输入拒绝且夹具文本/计数不变，历史回执保持，等待后未自动恢复或重建条。全程不启管理服务、不触发物理输入、不修改共享运行实例；不是向用户App注入故障，也未覆盖真实Profile准入及硬件接管。所有自有进程退出确认，无force fallback；原App40068保持idle。
- 前17轮私有字节升高后，22:02独立只读采样见原App私有字节121462784、句柄959，低于本轮基线；这是回落证据，不能把先前上升断言为泄漏，也不证明更长运行无泄漏。
- `pp-desktop-dialogs-AVKnYv` 在按官方要求将SetClientGuid作为创建后第一个COM方法后仍失败。新的完整回执定位唯一错误为 `IFileDialog.ClearClientData / 0x80004005`，Show正确返回取消 `0x800704C7`；正常退出和sessionnull。调用顺序修正未解决此异常，保留失败，继续研究独立Open案例。
- 窗口目录状态批次最终 **69项相关纯测通过**，完整 `npm run build` 成功。构建 `2d2205396f882ab1cd27158bfbca20b4b4f95e1a217660d8db665e56ac123e7a`，native摘要 `f6ddc4fd7cf2681e2a85c479b41dda9d8020fcf32203e6e71e49c506cacad303`，CLI `53cbd6737d08bdc4f46227224dcb4df0622362102a3ddbe61ee2417520301452`。
- 更新前复核40068原进程句柄/启动ticks、空桌面会话、28任务无活动；按实际缓存目录确认只有catalog34512。旧App与catalog均确认退出，预览19340保留。新开发App **PID38780** 通过Explorer独立启动，`startedAt=2026-10-29T22:05:01.656Z`、OS ticks `639289083014346516`，启动器退出后仍Responding。界面增加“暂不接收输入”“已最小化”状态字样；正在实际验收新构建。

第13轮目录实测与真实租约（22:05 UTC 起）：

- `own-ui-cb477dcd-c578-4610-86ae-5a27e062a07c-report.json` 实际App38780自查通过，前后UIA59个节点、状态轮询可见当前owner、WGC画面已视觉核对；actions为空，条件完成后sessionnull。安装到用户CLI目录的bundle与当前构建SHA256一致，两处已安装Skill的desktop参考也与仓库一致。
- `pp-desktop-dialogs-iosn8n` 单独Open尝试整轮失败：真实产品目录已返回父窗 `enabled:false/minimized:false`，原生对话框 `enabled:true` 且 `ownerNativeHandle` 精确等于自有父窗句柄。两次完整UIA观察均67节点、gaps为空，但未找到文件名编辑框，没有发送路径写入或Open。长自定义文件名label与文件类型区域坐标重叠，为布局问题提供线索但不是定论；已缩短夹具label，仍固定文件名set_value路线并明确排除搜索框及文件重命名编辑框，等待实跑。原窗口和会话均正常清理。
- 新 `verify-desktop-lease-expiry.mjs --run` 正在运行两个真实五分钟租约，不缩短生产TTL。`pp-desktop-lease-3exYn7` 第一轮active已通过：期限 `1793312046204`，首次结束采样晚246ms；旧action、新ID action、resume均为 `DESKTOP_SESSION_ENDED`，历史成功回执未变，owner27928与observer20892原进程均确认退出。第二轮显式handoff暂停的真实五分钟正在测量，尚未计整体通过。
- `.tools/desktop-verification/discovery-round-review-20261029/result.json` 10项纯审查通过（OS查询0）：真实准入计算器混合R2目录与尚新鲜的R1应用端口采样会误判unmanaged，完整R2则拒绝。下一轮瞬时PID缺失重采必须在共同发布点整轮更新两个来源，受原5秒deadline/AbortSignal约束；不能只重试RM或目录，不能自动恢复已暂停会话。正在实现与回归，未构建。

第13轮补充结果（22:20 UTC 起）：

- `pp-desktop-lease-3exYn7/report.json` 两个实际5分钟租约均通过，TTL未缩短。active/paused各29/30次采样，首次过期采样分别晚246/237ms；status、doctor和历史回执查询没有续期，输入generation与夹具计数不变。新requestId、原ID重放及resume均拒绝为`DESKTOP_SESSION_ENDED`，历史成功回执仍可读。paused轮的owner/observer在handoff时已正常退役，到期未复活。夹具36680按nonce正常退出，sessionnull，无强制清理。未隔离区分定时器和状态查询触发到期的贡献。
- `pp-desktop-dialogs-uWa1mL/report.json` 短label后找到真正文件名输入框，完成set_value和Open；Show返回0、只接受一次预创建nonce文件，父窗恢复enabled。仍仅`ClearClientData / 0x80004005`失败，因此整轮保持失败，不把选中文件成功等同于全部验收通过。夹具43032正常退出，sentinel/reentrant均0，sessionnull。
- 自有IPv6监听探针`netstat-ipv6-owned-probe.json`证实原`netstat -ano -p tcp`遗漏`::1`监听，`tcpv6`返回同一自有PID/端口。依据[微软netstat协议参数](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netstat)，发现层现在并行查询tcp/tcpv6，分别验证输出及地址族；两者完整才标记tcpComplete，部分证据仅保留为不完整结果。六项新增回归先5红1绿，修复后相关45项通过；原旧调用计数测试首次失败已保留并修正。实际探针runner是High，不冒充普通App验收。
- 发现重采实现通过16项新增、合计180项纯测试及TypeScript检查。仅同源完整apps证据伴随`windows_rm_pid_join`时，在两个原collect期限内最多进行一次完整新采样；原catalog/apps共同选择同一轮结果。过期先abort、pending复用不续期、迟到结果不更新lastKnown，首轮诊断仍记录。之后仍重新读取控制占用。日志`round_published`仅表示发现发布，不能代表控制授权，也未解决跨入口原子预留或PID重用。
- 合并以上两项后完整构建成功，buildId前缀`0febc8f42289ba89`。更新前实际status确认38780旧身份、桌面idle、28任务无活动；固定原进程句柄/ticks/hash/父进程后，旧App38780与catalog31312均确认退出，其他预览19340保留。新普通权限开发App21288经Explorer独立启动，启动器已退出。100轮实际会话循环开始，结果待定。
- 循环夹具上限由50扩至500（默认20），长批次寿命120分钟但仍要求30秒heartbeat；重复`--cycles`参数拒绝，原进程身份和nonce正常退出仍必须核实。500轮参数仅完成静态/编译检查`pp-desktop-cycles-63hqS6`，不能记作500轮实际通过。

## 第14轮：界面交还控制的旧请求隔离

2026-10-29 22:26 UTC 起，源码准备与纯反例；正在运行的0febc8f4循环构建不含本轮改动：

- `desktop-ui-return-fence-red.tap` 三项真实Service/IPC纯反例全部失败：旧owner的UI return会恢复后来暂停的successor；同owner的第二次takeover没有更换输入generation，旧return仍会恢复；工作区直接发送字符串`return`没有绑定显示中的会话。测试不启动GUI、进程查询或hook。
- `DesktopStatus.session`增加已有内部revision的只读投影；界面return携带当时显示的session、input generation、revision，Service在准入/新driver/ARM前核对，并保留等待准入期间的原revision与owner复查。IPC拒绝无身份字符串return；takeover/stop仍可立即撤权。CLI原有显式同名resume行为不变，不宣称所有入口都要求UI revision。
- Service、IPC和preload组合 **69/69通过**，TypeScript通过。中间两项测试因跨VM对象原型不同而失败，改为对序列化后的实际IPC对象逐字段比较；原结构和值并无差异。新增toolbar反例`desktop-ui-return-toolbar-red.tap`确认旧页面未传显示身份，正在等待100轮结束后统一修改public资源、构建和隔离真实链路验收。当前不计功能交付完成。
- 0febc8f4第44轮（index43）截图期间确实发生`windows_rm_pid_join`，缺失PID43820。日志保存到`pp-desktop-cycles-d0dusS/discovery-retry-events.json`：首采时间`1793312969097`，新采`1793312971561`，22:29:33.551发布整轮；随后占用检查和本轮结束成功。截图请求4641ms，仍在原5秒发现预算内；不是先暂停再自动resume。未据PID事后状态猜测其当时身份，整个100轮结果仍待完成。
- 原生对话框新增显式`--cleanup-after-release`单案例诊断，11项纯测试及编译`pp-desktop-dialogs-9eC7ub`通过，尚未实跑。原对象ClearClientData失败保留；只有同nonce GUID已设置、Show已返回、Unadvise/item/folder/原RCW清理无其他错误时，才用不Show的新COM对象设置同GUID并Clear一次。独立busy覆盖释放重入；不清默认用户历史，不重放任何输入，也不因新对象清理成功抹掉旧实例失败。FinalRelease仅记RCW释放，未声称持久化已提交。

第14轮长循环结束（22:37 UTC）：

- `pp-desktop-cycles-d0dusS/report.json` **100/100实际App循环通过**，22:23:34.761–22:37:05.383，共13分30秒。同一普通权限App21288，精确startticks`639289094026023453`；每轮claim、UIA observe、image-only screenshot、条件complete、旧会话拒绝及原owner/observer退出均确认。最后仅catalog44720，fixture42684按nonce正常退出，sessionnull，无force。未发送物理或UIA写入动作，不是数小时输入稳定性或泄漏证明。
- 完整日志补确认第85轮（index84）也发生一次整轮重采，两次均在原预算内发布并完成后续准入；已将4条对应事件更新到同目录`discovery-retry-events.json`。第44轮截图4641ms，第85轮4827ms；不是暂停后自动恢复，也没有第三次重试。
- claim中位2247ms、p95 2455ms；UIA中位2360ms、p95 2526ms；image-only中位2153ms、p95 2326ms。9次进程指标采样遇到已退出的瞬时子进程后重采，不把权限或未知状态当退出。基线句柄923/私有字节170917888，最终采样964/184451072，最后清理采样958/184659968；记录波动，不作长期无泄漏结论。
- 循环退出后才修改实际public toolbar资源，避免运行中混用版本。新return身份与revision实现的相关组合 **173/173纯测试通过**，尚待完整构建、独立App更新及真实链路验收。

第14轮普通权限采样原型与UI构建（22:38–22:39 UTC）：

- `pp-windows-sampler-uGYc1o/report.json` **5轮普通权限只读对比通过**。Medium Node runner15564、自有fixture22640，独立身份检查确认无提权/uiAccess；自有唯一文件的RM创建时间与固定进程句柄GetProcessTimes、候选snapshot逐轮一致，IPv4/IPv6自有监听均被两种方案找到。payload只在内存使用，报告不保存全量用户进程命令行。两个进程按nonce正常退出，无force。
- 每次查询均创建新helper/PowerShell，5轮交替先后顺序；未重置OS/JIT/杀毒软件缓存，不能称真正冷启动或因果隔离实验。process+双族TCP中位legacy766.997ms/candidate411.809ms；单自有文件RM中位534.506ms/215.192ms。采样时刻不同导致进程计数略不同，不要求非原子查询的全量集合完全一致。尚未接入App准入，不能将这些数值直接当UIA端到端加速。
- 独立原型C#29项纯检查及Node23项纯测试通过。协议严格保留raw UInt64 FILETIME字符串，拒绝重复JSON键（含转义同名）、非法UTF-8/孤立surrogate、越界记录、混合身份、清理失败；native查询8秒是合作预算，父进程仍须硬deadline并确认退出。后续接入仍需strict join/祖先身份校验及打包兼容。
- UI return批次完整构建成功，build`76571a60572a17ff719eba4ed1a57d7e5dbb9c456a854a074aed449fc6e5ab81`。更新前21288身份及idle/28任务无活动确认，固定原进程句柄/ticks/hash后旧App和catalog44720退出；预览19340保留。新普通权限独立App **PID6780**，`startedAt=2026-10-29T22:39:08.180Z`、OS ticks`639289103479543832`，启动器退出后仍Responding。新对话框清理诊断正在串行运行；旧UI请求真实链路验收尚未完成。

第14轮UI真实链路验收（22:39–22:43 UTC）：

- `pp-desktop-dialogs-U1qhiK/report.json` 对话框诊断仍失败。Show返回0，只接受一次自有文件，父窗恢复；原ClearClientData为E_FAIL，原RCW释放确认后，新对象首调用同nonce SetClientGuid成功，但fresh Clear同样返回`0x80004005`，新RCW也正常释放。该结果不支持“只需释放旧对象再清理”的解释，也不能据此证明没有持久化状态。fixture44912正常退出，sentinel/reentrant均0，sessionnull；不再盲目重复该清理调用。
- `own-ui-bd6bfc45-004c-49b3-866f-b24709b99fab-report.json` 新App6780自查通过：前后59个UIA节点、三次状态查询后画面仍显示正确owner，WGC截图已视觉核对。capture-only无动作，条件结束成功，sessionnull。
- `pp-desktop-ui-return-fU4TLZ/report.json` **5项真实隔离链路通过**（22:43:08.875–22:43:29.248）。普通权限隔离Electron8012运行真实registerDesktop/Service/defaultWorker/WindowsInputRuntime、实际preload和public提示条，唯一fixture38396。真实页面保存已渲染的A身份；B替换并暂停后经同一preload发送旧A，B状态/期限/driver/observer均不变。同一B的再次takeover提高revision，旧B身份也拒绝；缺身份return经IPC schema拒绝，提示条未被误撤销。
- 一个事先定义的当前页面button.click处理器正常恢复，产生新输入generation和新driver/observer，并通过fresh observe读取fixture；没有鼠键或UIA写入，fixture输入回执未变。没有拦截状态推送、后台读取新身份替换旧请求或失败后自动恢复。所有自有进程正常退出，无force；原用户App6780前后idle，source hashes未变。
- 这是隔离真实服务/页面链路，不是向用户App注入延迟消息，不覆盖真实Profile占用目录、全局快捷键或物理鼠标点击。已确认的范围按此记录，不把纯测试、隔离链路和实际用户App混为同一种证据。

## 第15轮：原生采样接入、失败退场与比较基线（进行中）

- 开始把已验证的原生采样器接入严格 Windows 控制发现。普通展示缓存和旧的非严格 PID 查询仍保留原路径；macOS 不加载或启动 Windows helper。严格 RM 关联保留原始 UInt64 创建时间并核对同轮进程身份，父进程比子进程年轻时拒绝祖先推导。新身份错误与原有缺 PID 的有限重采错误分开处理。
- 生产 client 使用有界串行队列，同一调用的排队和执行共享原始截止时间；只有实际 child close 才允许后继。关闭先于懒初始化时也永久禁止再启动。根复跑 client/protocol/冻结基线与关闭流程组合 **66/66通过**，尚未以此宣称实际App接入通过。
- 交叉审查发现两个失败反例：native查询先失败时 TCP 子查询仍未settle；native准备耗尽预算后 TCP仍以1ms超时派发。要求修复并加入反例后再构建，避免失败时后台采样堆积。
- 性能脚本现在保留 `pp-windows-sampler-uGYc1o` 当时的历史源文件原字节（sha256 `645958b10f0ccc82b07c48c751fafeb7d86e761ba037c6d6c2baff292ec65373`）及独立metadata。纯fake实调验证旧路径确实调用PowerShell process/RM与tcp/tcpv6，candidate调用0；禁止从基线解析当前候选模块。
- 更新脚本后的 `pp-windows-sampler-vshZ54/report.json` **5轮普通权限只读对比通过**（22:57:17.475–22:57:29.808）。runner33228、fixture11080均Medium；自有文件raw birth `134377882396712770` 与独立固定句柄读数一致，两种方案均发现自有IPv4/IPv6监听。process+TCP中位legacy677.193ms/candidate350.922ms，单文件RM中位501.376ms/199.634ms。两个进程正常退出且确认原进程已退出，无force。仍是原型、顺序交替、单Windows环境实验，不是当前App端到端性能。
- 接入批次 **194/194组合测试通过**（`windows-sampler-integration-suite.tap`），`tsc --noEmit`及完整build成功。两个异步反例已修复：原失败等待双族TCP实际settled；每family单次读取时钟并检查remaining，预算耗尽不启动。无snapshot的严格文件查询也使用新采样器；兼容注入sample缺context时，8秒回退在await之前创建，不能等待完才续期。
- 构建 `41699f139a09d763d5c9a8c55d58633396117a8169c4d0388d8537dfdcc4ba5d`（23:03:09.780 UTC），CLI sha `1f27c71625da016783c8255549f6148b53a9c5c0a1e33ac97f08768217a9e6a0`，sampler sha `fd91a3dc9ab211ce9b98f78488f212b908277f91282f9e0b0989f5b7bd46f430`。旧App6780/catalog38076精确身份与句柄固定后退出（`sampler-416-retirement.json`），28任务无活动、desktop idle，预览19340未动。新普通权限独立App **41124**，startedAt `2026-10-29T23:03:58.718Z`、OS ticks `639289118384535298`；启动器结束后仍Responding，运行build与manifest一致。
- 新循环脚本将 `profilepilot-windows-sampler-runtime` 纳入直接native子进程监测，按manifest核对hash，成功读取返回后要求sampler数量0；编译-only `pp-desktop-cycles-OfW4JG`通过。新App的100轮真实循环已启动，尚未结束，不提前记为通过。
- 已明确下一项生命周期缺口：当前native 8秒预算是合作式，父client能硬取消并等close，但父App异常退出且WMI卡住时，helper尚无独立自退。下一独立小批评估10秒进程自退；当前构建不声称已覆盖该场景。

第15轮实机停止与生命周期结果（23:12–23:15 UTC）：

- `pp-desktop-cycles-tKFctF/report.json` **整体失败，前81轮通过，第82轮observe停止**（23:04:20.322–23:12:38.897）。snapshot `90d053e1-cab5-43e1-adb2-9f53ed65289a`、capturedAt `1793315555773`、512行中PID43756触发`windows_rm_birth_join`；服务以control_state_unknown暂停，未重试该身份错误、未恢复会话。该stage也被command/profile路径匹配使用，现有诊断无法区分identity unavailable与真实RM birth mismatch，不能仅据stage断言发生了PID复用。将补充有界origin/reason再定位，不放宽身份检查或重采资格。
- 同次循环第33轮observe和第38轮claim各出现一次原缺PID整轮重采，均在原预算内成功；4条事件在`discovery-retry-events.json`。这不包含第82轮身份错误，也不是暂停后的自动恢复。
- fixture40180按nonce正常退出，owner/observer/sampler均已退场，仅catalog36744；最后sessionnull，App41124身份不变。清理采样句柄978、私有字节188182528，初始基线929/178634752；1次瞬时进程采样不稳定。未出现强制清理，不能把81轮结果提升为100轮稳定性通过。
- `timing-comparison.json`保留同机顺序运行、最近秩P50/P95的原始统计。返回成功的claim 82次P50/P95 1594/1861ms，observe 81次1709/1874ms，image-only 81次1491/1671ms；旧100轮对应2246/2455、2359/2526、2152/2326ms。样本量不同且本轮被失败截断，不是因果隔离实验或无失败速度承诺。后续脚本也会记录失败调用耗时与method，不为收集成功耗时而重发。
- `pp-sampler-client-uMRHXl/report.json` **4类实际生产client生命周期通过**（23:15:16.676–23:15:18.836），实际加载416版dist client/protocol/native-runtime/helper，默认hash运行路径未替换。Medium runner41128，normal333ms；真实spawn+stdin finish后Abort、旧close序号12后才后继spawn序号15（334ms）；75ms原deadline实际81ms返回TIMEOUT；关闭active+queued后46ms结束，永久拒绝新spawn。5个实际helper全部close，runner正常退出，无fallback force；正常/后继的own raw FILETIME与独立runner出生时间精确相等。stdin finish不代表WMI已进入，未把它说成provider内部中断验收。

第15轮独立自退与诊断（23:15–23:25 UTC）：

- 原生sampler从Main启动独立watchdog线程，以10秒为退场阈值；主线程stdin/provider/stdout阻塞不依赖父App事件循环。只用自身GetCurrentProcess伪句柄调用TerminateProcess，意外返回时以Environment.Exit(2)兜底，不接受外部PID或OpenProcess权限。选择依据是[ExitProcess的DLL detach死锁边界](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-exitprocess)与[TerminateProcess契约](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)，不是已经复现当前CLR死锁。OS调度、pending I/O、CLR启动可延迟实际退出；正常Run后的CLR teardown不在保护范围，不保证finally执行。
- `pp-sampler-watchdog-AZlIL8`与`igzSPM`均保留整体失败。前4类通过，父进程场景先把Node close当成进程死亡。第二份记录证实父进程exit约246ms、close约10秒；清除自身3个标准句柄继承位后仍出现延迟，不能据此断言已排除所有继承句柄。脚本现分开记录exit/close，先确认父进程exit，再独立固定子进程PID/birth/exe/hash确认仍活着，最后等待子进程自退及父管道close；首次kill回执不会被清理重试覆盖。
- `pp-sampler-watchdog-xoYy6S/report.json` **5类实际生命周期通过**：正常协议错误259ms、未结束stdin10056ms、模拟阻塞provider10062ms、正常取消后保持存活11053ms；父43532在244ms退出，245ms开始的独立身份探测确认子40068仍活着，子进程固定出生时间`639289131095119091`后10043ms以2自行退出，随后管道关闭。没有兜底强杀或GUI/hook；父进程的计划终止是场景触发。阻塞provider是夹具，不是注入真实WMI内部故障。Node5项纯测试及嵌入17项C#纯检查通过。
- 身份失败补充有限`origin/reason/identityReason`，包括command/profile、RM、parent、runtime、batch来源及not_pinned等不可确认原因。新字段严格组合白名单，不保存完整命令行、路径或原始birth，不改变错误类别、deadline、暂停或重采资格；旧缺PID仍是唯一重采条件。组合 **197/197纯测试通过**（`windows-identity-reason-suite.tap`），尚待新build实测；无法用新字段倒推旧第82轮的具体原因。

## 第16轮：窗口状态与统一构建（进行中）

- 新增`restore/minimize/maximize`，只接受所选窗口根的ref/version；UIA原生句柄、状态、能力与IsIconic进入同一观察fingerprint。restore指Normal，不隐式恢复历史maximized状态。只有已确认最小化的enabled根可以通过restore的offscreen例外；modal、非Ready、未知provider状态保留拒绝。
- SetWindowVisualState只派发一次，之前消耗版本，之后重新FromHandle核对RuntimeId/PID/birth/HWND，并要求UIA visual与Win32 placement一致。400ms是只读确认预算，不能中断同步provider调用；外层worker仍负责隔离。派发后无法确认进入unknown暂停，不自动重放。foreground记录仅作证据，不授予后续坐标权限。
- 实现与harness共 **124/124纯测试通过**，tsc、完整native编译与compile-only `pp-desktop-window-state-PpIV2M`通过；截至此处尚未实跑窗口转换。待交叉审查、统一build及普通权限实际App验收。README未改。
- 只读交叉审查未发现production阻塞缺陷，专项10项纯测通过；发现启动有副作用后launcher抛错会跳过fixture清理，以及WM_QUERYOPEN计数不能独立证明只有一次UIA派发。正在补清理反例并收窄实测措辞。另已补watchdog报告对`cleanupUnconfirmed`的拒绝断言，5项纯测通过，原xoYy6S按新校验重新通过，历史报告未改。
- 完整build **7e96be71e2758842bff15320041c27402b06610fa77901941efae940ea4d029f**（23:27:12.883 UTC）成功，desktop sha `13647be594677670d54ec270d62e4e4aaaae6f6c39c02b50cb25c245fde606f2`、sampler sha `468d6ca77946641ba5aa582b35cc5fec0fe0ac3feaf661a2b56f2b840fb712cf`、CLI sha `4bee5dc6b38ca3dab51b70382cdba3f23424c37b2fc8b05ad521d02a428d3b0c`。旧App41124/catalog36744固定句柄/出生时间/hash后退出，原预览19340未动；新独立普通权限App **17592**，startedAt `2026-10-29T23:27:43.961Z`、OS ticks `639289132637372011`，启动器退出后Responding。
- `own-ui-0fd11f31-2373-466d-aa17-bdb5b7e69bf3-report.json` 自身界面只读验收通过（23:28:23.600–23:28:39.584）：59个UIA节点、三次状态轮询、WGC画面已视觉核对，当前会话展示一致，条件结束成功且sessionnull。Electron根已读到WindowPattern、interactionState2及3种状态动作；本项没有派发动作，不能当窗口转换通过。
- 新sampler二进制的生产client复测 `pp-sampler-client-Aku7N4/report.json` **4类通过**（23:29:17.163–23:29:19.298），Medium runner39900，正常/Abort排队/原deadline/close拒绝新调用；自有runner正常nonce退出且确认原进程退出，无兜底force。
- 窗口harness启动后throw清理修复已通过9项pure，连同共享退出逻辑20项；默认compile-only `pp-desktop-window-state-L3vwg6`通过。launch之前锁存attempted，恢复自有nonce ready与完整进程身份后才能wait/force；无法恢复仍写nonce close并保留失败。恢复时parentPid只能记录已检查的正整数，不能宣称与不存在的先前parent回执匹配。
- `pp-desktop-window-state-QkJ24b/report.json` **实际basic通过**（23:31:25.051–23:32:20.034），同一App17592/7e96、Medium fixture40352、birth`639289134871511022`。7次转换均由UIA、Win32 placement与fixture自身状态确认，回读6–24ms（不含派发与CLI/准入耗时）。maximized→minimized→restore最终为Normal；孩子ref、额外keys、不支持的maximize均拒绝，旧能力fingerprint变化返回ELEMENT_CHANGED，显式handoff后旧动作USER_IN_CONTROL。fixture值/键盘消息未变，按nonce正常退出，无force，sessionnull。
- Ready与CanMin/Max/modal条件参考[Microsoft WindowPattern官方示例](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.windowpattern.setwindowvisualstate?view=windowsdesktop-10.0)；它是所选保守策略的依据，不能据示例承诺所有provider兼容。拒绝restore的独立实际场景仍在进行。
- `pp-desktop-window-state-PCdxqE/report.json` **实际拒绝restore场景通过**（23:32:46.137–23:33:52.067），Medium fixture21244、birth`639289135680176346`。自有窗口拒绝WM_QUERYOPEN后，UIA/Win32均保持minimized/showCmd2；422ms确认读后返回OUTCOME_UNKNOWN，cause WINDOW_STATE_UNCONFIRMED，控制暂停reason outcome_unknown。500ms观察期间仍minimized/paused，同generation，queryOpen增量0；消息计数不等于UIA调用次数。fixture按nonce正常退出、无force、sessionnull。该场景前置的7次正常转换同样通过。
- watchdog新增stdout背压case，8项Node纯测试（含17项C# fake检查）与compile-only `pp-sampler-watchdog-tfe9eq`通过。`pp-sampler-watchdog-kBvtqL/report.json` **同生产源码的独立编译helper/fixture共6类实际通过**：正常协议错误与stdin阻塞使用独立Prototype.exe，其他场景使用真实watchdog加自有夹具，不是bundled二进制或生产App故障注入。stdout fixture28236计划写16MiB、64KiB块；harness暂停应用消费，收到两个stderr nonce marker且无write-returned。真实exit在10058.607ms，随后开始drain并于10059.265ms确认close；实际只计131072字节，不保存payload，无兜底force。Node/OS可能预缓冲，本项不是底层零读取、真实WMI故障或生产snapshot巨型响应验证。
- 长循环harness同步补启动握手失败后的nonce清理：独立lifecycle模块，10项纯测通过，包含整份脚本在fake I/O下launcher已启动后throw、后续status也失败仍清理的反例。原失败不会被正常清理改成PASS；任何force或身份不明均保留FAIL。新100轮真实App循环已启动，使用上述7e96构建，待结束后记录完整结果。

第16轮稳定性定位（23:41 UTC）：

- `pp-desktop-cycles-9xupa2/report.json` **整体失败，44轮完成，第45轮(index44)observe被阻止**（23:37:21.427–23:41:54.810）。本次字段明确为stage`windows_rm_birth_join`、origin`restart_manager`、reason`unavailable`、identityReason`not_pinned`，PID44460、processCount516，snapshot`f6e1a647-c1d7-48d3-bb99-dd2b1be54dcd`、capturedAt`1793317311642`。第45轮claim1719.836ms，失败observe2302.797ms；不是raw birth mismatch，也不能倒推上一轮tKFctF第82次失败同因。
- native在最初枚举后固定句柄，再读取CIM；新进程可能出现在后续CIM和RM结果里但没有最初的句柄，因此保持unknown是正确的。当前7e96没有对该类别重采，服务暂停后停止本轮，没有自动resume。fixture29172、birth`639289138430918022`按nonce正常退出，owner/observer/sampler退出，仅catalog42148保留；无force，sessionnull。
- 45条循环记录中44条ok。基线App句柄989/私有字节120455168，结束清理990/187621376，成功轮句柄主要983、短暂990；没有采样不稳定。记录内存变化，不能据4分多钟采样判断无泄漏或确定泄漏。
- 下一修复仅评估同一fulfilledsample精确匹配snapshot/time/count、该PID唯一row确为unavailable/not_pinned/null birth、并且origin为restart_manager的整轮重采。仍共享原两个context的deadline/abort，最多总两轮；不扩展birth_mismatch/open_failed/exited、parent/runtime/profile_command，也不恢复已暂停会话。正在纯反例与独立审查，尚未构建或实测。

## 第17轮：新进程未固定身份的有限重采

- 新增反例先在旧实现产生3项失败（22项中19通过），记录`windows-not-pinned-retry-red.tap`。实现后专门验证精确RM来源、同一sample/time/count、唯一PID行、显式null birth及not_pinned；带任何own `identityWin32Error`属性（包括undefined或getter）都不重采、不执行getter。
- 只新增上述资格，仍丢弃整轮首采并重做catalog/apps/sample；第二轮正常完成还必须通过严格RM出生时间关联及完整性检查。共享原两个deadline和AbortSignal，最多两轮，不续期、不拼接、第二次失败不重发。组合 **58/58纯测通过**，tsc通过，记录`windows-not-pinned-retry-suite.tap`。
- 独立复核专项37项通过；实际RuntimeAdmission→DesktopService配fake采集的4种组合（observe/action×takeover/stop）均在第二轮pending时撤权，迟到成功仍USER_IN_CONTROL，0次窗口读取/动作派发，保持原上下文与两轮上限。本项是纯组合检查，无OS/GUI，不提供跨入口原子reservation。
- 完整build **a823c44a5e537849f777cc5a717dccc1dbe2687ef28b0c181a7efddc2fa1b5de**（23:49:13.084 UTC）成功；CLI及native desktop/observer/sampler摘要与7e96相同，变化在App发现逻辑。旧App17592/catalog42148固定句柄、birth、exe/hash后退出（`unpinned-a823-retirement.json`）；预览19340保留。新普通权限独立App **32176**，startedAt`2026-10-29T23:49:46.875Z`、OS ticks`639289145866523259`，启动器退出后Responding且desktop idle。100轮复测已启动，尚未结束。

第17轮完整复测（00:00 UTC）：

- `pp-desktop-cycles-Jkkzhl/report.json` **100/100通过**（23:50:03.129–00:00:10.212），普通权限App32176/a823身份不变。第34轮claim、48与63轮image-only各出现一次原`windows_rm_pid_join`整轮重采，均成功；六条事件与cycle映射保存在`discovery-retry-events.json`。本轮未观察到新增`not_pinned`资格实际触发，不能用这100轮替代该分支覆盖声明。
- App基线handles922/privateBytes194011136，结束清理963/183283712，后段handles主要963。四次进程采样不稳定分别是已退出的NETSTAT或ADB子进程，均保留诊断并在后续完整采样成功后继续，不将瞬时枚举当作所有子进程实际close的证明。唯一保留native子进程为catalog27544，birth`639289145933734199`。fixture34520、birth`639289146048188484`按nonce正常退出并确认原进程退出，无force，sessionnull。
- 基于前两轮真实中断及新native接入，开始同一冻结构建的500轮延长测试，继续收集身份重采、子进程与资源趋势；截至此处尚未完成。
- 延长测试目录`pp-desktop-cycles-ukWl7z`，开始00:00:37.490 UTC。00:02:26.406和00:05:25.760实际触发RM/unavailable/not_pinned有限重采，对应第18、47轮，两轮均完成；00:19:56.148再次触发并发布第二轮发现。分段保存事件，避免长运行超过日志查询数量上限。00:22约210/500，仍为进行中，不能提前把500轮记为通过。
- 只读复核发现验收采样器本身的局限：完整native stdout的SyntaxError或执行ENOENT可能被通用ready-file轮询重读，未记录的历史情况无法事后排除；迟到成功也未再次检查原期限。产品CLI请求本身仍严格校验，本缺口限制资源/退场采样证据。候选补丁将native协议/执行失败区分为不可重试错误，并在read返回后核对原期限；保留ready文件暂态重读。当前源码19项中5红，隔离候选19/19通过；不在500轮中途替换脚本，结束后应用并做专项实跑。

第17轮延长验收完成（00:51 UTC）：

- `pp-desktop-cycles-ukWl7z/report.json` **500/500通过**，00:00:37.490–00:51:18.183 UTC，同一冻结a823构建、App32176，未发送键鼠输入。第18、47、191、360、405、429、482轮各实际触发一次RM/unavailable/not_pinned整轮重采，七对事件与成功cycle映射保存在`discovery-retry-events.json`。分段查询文件及SHA256保留，未发现重复或冲突事件；日志发布成功与CLI循环成功分别核验。
- claim / UIA observe / image-only / complete 的p50分别1597.269 / 1697.599 / 1513.839 / 122.904ms，p95分别1779.505 / 1881.687 / 1681.613 / 133.506ms。每轮退场采样句柄min959、p50961、p95968、max974；私有字节min114208768、p50188301312、p95191909888、max194256896。中段实际回落，结束handles963/private187797504；这不是堆保留分析或无泄漏证明。
- 22次可识别的不稳定采样保留诊断。历史采样器可能吞掉完整stdout解析/执行错误的局限仍适用，不能把500个后来样本当成每个helper独立退出回执。PNG/SVG/CSV趋势图和源报告hash绑定摘要已生成，PNG已视觉检查。
- 结束sessionnull，保留catalog27544；fixture42688、birth`639289152391268855`收到nonce_close并独立确认原进程退出，无force。完整报告成功结束后才解除源码/构建冻结；旧失败9xupa2和tKFctF没有删除或重算为通过。

## 第18轮：TCP原型实测与采纳判断

- 独立`GetExtendedTcpTable`原型使用单独protocol，不修改生产native v1。严格检查IPv4/IPv6 ABI、DWORD返回、4次fill/8MiB/总65536行上限；任一族失败都拒绝complete，保留raw scope，拒绝保留state100。仅投影LISTEN/ESTABLISHED，不提供process birth join或跨入口原子性。原型及harness纯测通过，独立审查无阻止隔离实跑的问题。
- `pp-windows-tcp-qO0GOZ/report.json` **普通权限5轮交替对比通过**。Medium runner41584、birth`639289152251246045`拥有IPv4/IPv6 loopback listener及已建立连接，两条路径都发现自有端点。5个native helper确认真实close且无force，runner收到nonce关闭、关闭2个server/4个socket并确认原进程退出。全量TCP表只留内存，报告仅保存自有端点命中与聚合信息。
- netstat wall中位**32.019ms**、native原型**81.652ms**；首轮37.689/119.792ms。native API内部约6ms不等于进程全流程，candidate还包括fresh CLR/helper、自身身份检查与hash。候选减少采样子进程（每轮2→1）但本实验没有性能优势，暂不替换生产TCP。现有TCP与process采集并行，因此也不能据API内部读数宣称App端到端加速。非零scope、bind-only、出生时间关联及生产准入均不在本项覆盖内。
- 进一步以真实RuntimeAdmission→DesktopService配fake采集检查PID-only关联：`desktop-apps-identity-review.test.js` 7项、45组纯组合通过，无OS/GUI。confirmed不同raw birth与not_pinned/open_failed/exited/wait_failed变体中，相关listener、unknown runtime及已知Gateway/本地owner均保持拒绝；缺process行/目标不在universe也unknown。known runtime+Gateway明确idle在不可读birth时仍available，证实现有身份边界，但没有据此复现已知占用目标被放行。当前listener证据只会阻止无监听空路由证明；暂不因非关联系统行不可读而扩大拒绝。未来若增加同批句柄覆盖TCP的采样，仍不能替代跨入口reservation。

## 第19轮准备：命令提示、参数表达与阻塞读取

- 用户界面纯反例复现旧窗口消失后仍显示旧claim、固定任务名完成后不能复用、不可用期间迟到preview/windows及插件参考不同步。候选修正清理失效选择，以availability代数拒绝迟到列表；空闲时展示独立示例名，手动刷新/重选可换名，轮询保持稳定；已有任务只提示查询状态。没有自动claim/select/resume。另将fresh-observation提示改为不假定driver一定更换。新版10项纯候选通过，仍未合入冻结运行版本。
- plugin中的desktop参考是`package-codex-plugin.mjs`生成品，待通过现有`plugin:sync`同步，不手写生成文件。CLI等号参数与支持键名帮助的候选仍在独立验证。
- 准备真实普通权限自有provider属性读取阻塞验收，分别验证wait deadline与CLI explicit_release。必须确认进入getter且wait仍pending，才可判定场景成立；若Windows自身提前结束读取，则不把它算成ProfilePilot成功取消。旧owner/observer将按精确身份独立确认退出，夹具独立nonce线程解除gate后正常关闭。当前尚未实跑，不作为已通过能力。
- 交叉审查纯复现原`explicit_release`归因假PASS：真实Service先因takeover结束wait、CLI输出延迟，随后release结束paused owner，旧harness仍可把延迟返回归因于本次release。第二case已改为`conditional_complete`，实际调用`complete --require-active`，原release编译报告保留。独立真实Service/fake observer反例确认先接管、observer失联、read替换后pending都拒绝，只有仍active/ready的挂起wait可以条件结束；没有为验收改生产接口。新harness相关72项pure通过，compile-only `pp-desktop-provider-block-lM6H3p`通过，待最终复核与串行实跑。

第19轮合入与构建（00:52 UTC起）：

- 500轮结束后合入UI提示、CLI等号值参数/完整键名帮助，以及验收采样器错误分类和迟到期限检查。更新canonical desktop Skill的空文本/前导双连字符参数写法与键名，执行现有plugin:sync/check同步生成品；README未修改。
- UI/CLI/采样器、原控制/schema/wait/window-state、status-feed/IPC、Skill安装和插件相关 **147项纯测试通过**，记录`round19-guidance-tests.tap`；完整build正在进行，尚未把新界面记为实机通过。
- dialog验收器另修launcher已创建进程但握手throw后跳过cleanup：先红反例再修复，15项pure通过，compile-only `pp-desktop-dialogs-eUkZo4`通过。即使status失败仍nonce-close；未知身份不裸PID强杀，任何强制清理仍FAIL。旧U1qhiK的ClearClientData E_FAIL保持失败，未重跑文件选择。
- 父进程异常退出时，native读线程EOF只设置cancelled；同步UIA或stdout阻塞可能阻止主线程退出。当前是源码边界，隔离真实DesktopWorker/native的普通权限parent-death探针正在准备，尚无实机复现或生产自退guard。健康catalog不能设置固定总寿命；若需要兜底，必须区分进程退出与输入释放证明。

第19轮实机进展（00:53–00:55 UTC）：

- 完整构建`6c0018809dd043dd53c33fdead4656c943eb4729e88774d7f5b6c9c002529e3d`成功，CLI摘要`b6341de7fdc24afd7604ab8242a937e94921c15c22cc94af556fefa7dfd4a752`；native三项未变。旧App32176/catalog27544原进程均退出，catalog无需force，其他预览19340保留。新App **45572**通过Explorer独立启动，startedAt`2026-10-30T00:53:12.114Z`、OS ticks`639289183918735501`，启动器退出后Responding。两处已安装desktop Skill与仓库SHA256均`97fbb353684478c9de8bd04518cbfcbf305ad596305237c9b9d4d6a718d12825`。
- 首次provider-block `5dMs9f`在baseline失败，真实Window根和TitleBar同名，原harness误要求全树名称唯一。未arm、无输入，fixture44040正常退出。新增真实TitleBar反例先16/17通过，按name+Window role定位后17/17通过，并给CLI wait加`--role Window`；没有修改产品或降低pending/退出判据。
- `pp-desktop-provider-block-a4EhB3` **实际deadline通过**，Medium fixture38976，getter在派发后1533.268ms进入；4s wait返回exit75、oktrue/timedOut、attempts1且无observation，CLI全程4134.467ms。原owner43780确认退出后，owner仍active、revision+1、observer同generation pending且未重arm；仅cleanup release结束会话/observer41844。两者退出时provider仍阻塞，随后才显式解除gate。
- `pp-desktop-provider-block-Mg1n1g` **实际conditional_complete通过**，Medium fixture16260，getter在派发后1897.053ms进入；仍active时`complete --require-active`成功并结束会话，wait返回exit75/USER_IN_CONTROL。owner42828与observer40244均在provider解除前独立确认退出。两轮夹具均nonce正常退出、无force、键鼠计数不变、最终sessionnull；这是原生产取消路径验证，不证明worker自然退出或任意第三方provider可中断。

## 第20轮：异常父进程、COM诊断与可见界面

- 严格采样器修正后的`pp-desktop-cycles-TJlazi` **10/10实际回归通过**（00:55:05.528–00:56:11.044），新harness SHA`eed821511fbaa1ab2339c9560ee21045ffda7800539d2744304fd8d00486b2e2`；无不稳定采样，自有fixture正常退出、无force、sessionnull。它不回溯消除旧500轮采样器的历史局限。
- `pp-desktop-parent-death-oCYicd` **隔离Node父进程故障实验通过**（00:57:29.917–00:57:33.967）。实际dist DesktopWorker/native1364运行于独立Medium Node父进程12676，helper45560；observe发布后486.994ms内独立确认父进程原进程已退出，随后确认helper原进程退出，provider始终pending/returned0。之后才释放provider，fixture29024正常退出，cleanup force为空。不是对当前App45572注入崩溃，不证明EOF协作退出；未实际复现helper遗留，故没有实现native self-guard。
- 退出机制继续核对Node/libuv Windows Job与产品Electron版本差异：默认非detached spawn可能由Job关闭回收，不能只凭host.cs没有独立timer断言实际泄漏。对应源码和隔离Electron对照正在核查，尚不推广为所有环境的保证。
- `pp-dialog-cleanup-probe-jBDo9k` **诊断采集完成**（00:58:42.412–00:58:44.032），不是Clear成功或对话框整轮通过。13项纯测试后，以独立Medium STA进程20968，只使用旧U1qhiK固定自有GUID，CoCreate/SetClientGuid均返回S_OK，不Show/Advise；PreserveSig直接读Clear返回`0x80004005`，与旧异常HResult一致。RCW及原接口释放、CoUninitialize和原进程正常退出均确认，无force。旧FAIL不变，没有查询注册表或宣称历史为空。
- 实际自有UI `own-ui-0f7ee288…`仅read/capture，`own-ui-c9eb9bd9…`另通过一个fresh UIA Invoke选择当前App45572，`--name=ppilot desktop status --role=Text`实际CLI等号参数与wait匹配通过，三次status轮询均保持owner文本。最终sessionnull；安装CLI SHA与dist b634一致。两轮WGC实图已检查。
- 第二张实图也暴露显示问题：选中后的预览402物理像素高，将命令Text推到y1065/offscreen=true（窗口y35、高959）。上述UIA匹配成功不等于命令可见。正在将缩略预览限制为随视口变化的160–200CSS像素、object-fit:contain，并在实际UI检查要求命令非offscreen且完整bounds在App窗口内；完整原图/坐标协议不变。这是可见性小修，尚未完成新版实图验收。

第20轮布局验收与后续长测（01:03 UTC起）：

- 布局完整build `d5f8b3613a4c7140c4fd57ab7053f50837347042dcc226ffa1ffea39efc7e084`成功；CLI/native与6c0018一致。旧App45572/catalog41112精确原身份退出且catalog无需force。新普通权限独立App **25996**，startedAt`2026-10-30T01:03:10.096Z`、birth`639289189898432813`；catalog41444、birth`639289189965219209`。其他预览19340保留。
- `own-ui-17a0fe29…`实际选择自有App窗口并持续轮询通过；新预览593×247物理像素，命令bounds `[1002,909,217,21]`，offscreen=false，完整位于当前App窗口内。WGC实图已核对，结束sessionnull、App持续Responding。该场景是已有owner下的status命令；空闲唯一claim示例另有纯逻辑覆盖，不冒充此图验证了所有布局尺寸。
- 准备真实Electron主进程的隔离父死对照，使用同一生产DesktopWorker/native、独立temp路径、零BrowserWindow/webContents；短命bootstrap须先退出，只有bootstrap→Electron detached，生产helper仍非detached。19项pure、Node/Electron两份compile-only通过，尚未实跑。
- [Node22.23.4的libuv实现](https://github.com/nodejs/node/blob/v22.23.4/deps/uv/src/win/process.c#L66-L115)为非detached子进程设置关闭时回收的Windows Job；[关联失败分支](https://github.com/nodejs/node/blob/v22.23.4/deps/uv/src/win/process.c#L1017-L1035)允许特定ACCESS_DENIED，因此不是普适退出保证。[Electron42.3.3 DEPS](https://github.com/electron/electron/blob/v42.3.3/DEPS#L3-L7)固定Node24.15.0；实际runtime版本待新probe回执核对。[微软Job说明](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)说明进程关联及breakaway差异。现有oCYicd结果与该机制相符，但未观测Job归属或exitcode，归因仍是源码推断，没有新增native guard。
- 新严格采样器500轮目录`pp-desktop-cycles-p8SRt8`，01:06 UTC起运行，同一冻结d5f8b3/App25996。此轮专门收集修正后长时间资源证据；生产源码/dist/public/cycle脚本冻结至结束。只读collector每3分钟保存有重叠时间窗的retry事件、日志行数及是否达到5000条上限；首次两批未触及上限。尚未完成，不先计500通过。

第20轮干净检出检查（01:14 UTC）：

- 新no-Show诊断测试直接读取被忽略的本机U1qhiK报告，干净checkout会ENOENT。仅对该读取注入ENOENT的独立shim复现 **12通过/1失败**；没有移动、修改或复制原验收报告。
- 将exact retained-report复核标为缺本地artifact时明确skip，另外增加始终执行的未知bytes摘要拒绝检查。模拟干净checkout **13通过/1明确skip**，保留本地报告时 **14/14通过**。诊断runner的固定hash/GUID校验不变，其他读取错误仍失败；没有把私有报告加入仓库。
- 并行资源审查与Windows afterPack校验候选仍在只读/纯测试阶段，不改变长测中的生产构建。

## 后续候选方向

后续按实测结果调整优先级，每轮记录实际改动、通过证据、失败与未覆盖范围。

- 精确截图与坐标转换、裁剪/清晰度和跨 DPI 契约。
- 条件等待、定向控件读取、异步结果验证，减少无效观察和盲目重试。
- 原生弹窗关系、窗口生命周期与可操作性诊断。
- 输入中断、人工输入接管、进程退出和恢复压力测试。
- 可发现的 CLI 能力、错误恢复指导、界面可用性和分发构建验证。

## 交付检查

到时间后汇总累计改动与未完成差距，保留可复现脚本和报告；确认没有遗留控制会话或测试夹具，最终开发进程独立存活。不可用的设备、平台和权限场景只报告实际验证范围。
