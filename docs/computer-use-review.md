# Computer Use 对比与本轮改进

这是第 1 轮比较与历史基线。12 小时持续迭代的最新构建、普通权限实际 App 结果、失败及待验收项见 [迭代记录](computer-use-iteration-log.md)。下文 18 项原生夹具通过运行在较高权限的隔离环境中，不代表普通权限 App 的物理输入已经通过；后续源码也已变化，不能将这份历史报告当作当前版本的完整验收。

调研日期：2026-10-29。比较基线为本轮修改前的 ProfilePilot 本机桌面实现；本轮选定项及验收要求见下文。本文区分官方接口说明、源码可确认的行为与尚未执行的验收，不据接口列表推断任务成功率或速度排名。

## 比较的对象

| 对象 | 它实际提供什么 | 平台与边界 |
| --- | --- | --- |
| Codex / ChatGPT Computer Use 插件 | 桌面应用中的本地控制集成；本机 Windows 插件通过 `@oai/sky` 提供窗口、截图、UIA 和输入接口 | 官方产品支持 Windows 和 macOS；Windows 使用当前前台桌面，不能边控制边承诺用户继续使用同一会话。参见 [官方产品说明](https://learn.chatgpt.com/docs/computer-use)。 |
| OpenAI Responses `computer` 工具 | 模型返回有序 `actions[]`，应用提供执行器并回传截图 | 工具协议不等于 Codex 本地驱动，也不自动安装 Windows 控制服务。模型是否支持该工具与应用是否实现动作是两项条件。参见 [官方协议](https://developers.openai.com/api/docs/guides/tools-computer-use)。 |
| Anthropic Computer Use | 当前文档主版本 `computer_toolset_20260801`，17 个客户端成员工具 | 应用执行每次工具调用；官方示例使用受控 Linux 环境，不能据此认定已提供 Windows/macOS 原生驱动。参见 [官方工具说明](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)。 |
| REA | 逆向与原生调查的 MCP/CLI 工具，包含受约束的原生 UI 观察和动作 | 当前原生 UI 路径限定 macOS 14+，采用 ScreenCaptureKit 和 Accessibility。其 Windows 原生模块不等于 Windows 桌面控制器。参见 [固定版本原生调查说明](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/docs/native-investigation.md#L931-L973)。 |
| Windows-MCP | Windows 桌面 MCP 服务，覆盖指针输入、等待、显示器信息、区域截图等 | 官方说明包含多屏/DPI信息及硬件输入触发接管；接管明确是尽力而为，不能推断所有外部命令都会被取消。参见 [项目说明](https://github.com/CursorTouch/Windows-MCP)。 |
| Microsoft UFO | Windows 多应用 Agent 框架，具有应用 UI 执行器和部分办公应用专用接口 | [UI 执行器](https://github.com/microsoft/UFO/blob/main/documents/docs/mcp/servers/app_ui_executor.md) 覆盖双击、中键、拖拽和滚轮；[UIA 与视觉混合检测](https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/core_features/control_detection/hybrid_detection.md) 的 OmniParser 路径需要额外部署。 |
| UI-TARS Desktop / SDK | 模型、Agent 循环与电脑操作 SDK | [SDK](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/sdk/README.md) 显式传递屏幕尺寸和缩放因子；[动作空间](https://github.com/bytedance/UI-TARS/blob/main/README_v1.md) 包含双击、拖拽和滚动。模型识别能力与 SDK 实际执行行为需要分别验收。 |
| ProfilePilot `ppilot desktop` | 本机窗口发现、UIA、截图、输入、会话控制和 CLI；驱动随 ProfilePilot 分发 | 当前原生桌面支持 Windows，macOS 明确返回不支持。浏览器、Electron 页面和手机仍使用各自入口。本机桌面功能属于 ProfilePilot，不依赖 ClipRelay。 |

本机 Computer Use 插件核对版本目录为 `26.901.51231`，核对材料为该插件的 `SKILL.md`、`docs/api.md` 和 `docs/guidance.md`；这些是本机安装包说明，不能当作所有版本都稳定兼容的公开 SDK。REA 核对 commit 为 `8188497f13477918f2b696689c3598b65f11a7c5`；未安装或运行它的控制程序，也未把它加入 ProfilePilot 运行时依赖。

## 对 ProfilePilot 有价值的差异

| 方面 | 证据与实际差异 | ProfilePilot 的取舍 |
| --- | --- | --- |
| 鼠标动作 | 本机 sky 提供多次点击、中键、滚动和拖拽。OpenAI 的 [执行器契约](https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers) 也包含 `double_click`、`drag`、`move` 和坐标滚动。 | 原基线只有左右单击及依赖 UIA ScrollPattern 的滚动，无法覆盖一部分画布、分隔条和自绘控件。本轮补原生指针动作。 |
| 截图与观察成本 | sky 的窗口状态可以分别请求截图或可访问性文本；原基线 `screenshot` 仍先扫描 UIA，再抓图。 | 本轮增加 `screenshot --image-only`，让视觉任务不必等待 UIA 树遍历。需要语义动作时继续使用 `observe` 或默认截图。 |
| 动作后的证据 | OpenAI 的 [SDK 驱动契约](https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers) 在动作后返回截图且不自动重试输入；REA 的 [观察流程](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/src/native/NativeUiObservation.ts#L270-L319) 区分动作与后续观察的结果。 | 本轮增加 `action --observe`，返回单次动作后的新 UIA 观察；输入已发生而观察失败时保留动作回执，不能诱导重放。 |
| 批处理 | OpenAI 使用有序动作数组；Anthropic [批处理约定](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool#batch-actions) 要求依次执行、首个失败后停止并报告未执行步骤。 | 本轮不加入批量输入。先减少单动作的额外观察往返，保留观察版本、请求去重和接管检查。后续批处理需要逐步回执及部分完成语义。 |
| 坐标与细节 | sky 使用截图 ID、区域位置和尺寸；Anthropic 提供区域 `zoom`，并要求缩放后仍正确换算坐标。参见 [截图规则](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool#size-screenshots-to-fit-image-limits)。 | 本轮加强真实图片与坐标映射验收。外部 Chromium 截图裁剪不能精确映射时仍禁用坐标输入；WGC 后端、区域原图和自动坐标转换另行实现。 |
| 可访问性缺口 | REA 的 [AX 遍历](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/bridge/native/ReaNativeUI.swift#L115-L138) 区分读取缺口与确实没有子节点。UFO 的 [混合检测](https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/core_features/control_detection/hybrid_detection.md) 额外识别部分视觉控件。 | 本轮补 UIA gaps/截断信息，让 Agent 知道何处没有读全，不能把不可访问的控件当作不存在。本轮不添加 OCR/OmniParser 运行依赖。 |
| 图片证据质量 | REA 的 [图像数据校验](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/src/domain/native/nativeUiObservation.ts#L69-L132) 核查编码、摘要和图像尺寸；[原生验收](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/scripts/verify-native-ui.mjs#L132-L240) 不把权限拒绝当作正向动作通过。 | 本轮验证实际图像内容、坐标映射和应用事件，不仅检查文件存在或 JSON 返回成功。 |
| 平台行为 | Codex 官方产品明确 Windows 前台与 macOS 后台能力有差别；REA 原生 UI 是 macOS 路径。 | Windows 验收不能替代 macOS 验收。本轮保持 macOS 明确不支持原生桌面，后续原生驱动独立实现与验收。 |

ProfilePilot 已有的优势是统一的本地 CLI 路由、明确目标窗口、单一控制会话、用户接管、观察版本与控件指纹检查，以及请求回执去重。这些机制适合与用户共享的桌面。功能覆盖增加时仍应保留它们，不能把关闭检查后的动作成功当作能力提升。

REA 的原生动作目前主要依赖 AXPress、AXValue 和 AX 增减操作，并非任意截图坐标点击或全局鼠键注入；其 [Swift 实现](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/bridge/native/ReaNativeUI.swift#L45-L138) 的进程身份和观察证据设计更适合借鉴。Windows-MCP 的显示器信息、UI-TARS 的缩放字段与 UFO 的视觉补充则分别提示后续多屏、坐标协议与自绘控件识别的方向。UFO 的 [办公应用 COM 接口](https://github.com/microsoft/UFO/blob/main/documents/docs/mcp/action.md) 是专用能力，不能与通用鼠标工具按动作数量直接排名。

## 本轮落地范围与验收

以下各项已实现。实际通过范围及未通过、未覆盖场景分别记录在后面的验收结果中。

| 落地项 | 要解决的问题 | 验收要求 |
| --- | --- | --- |
| 原生 `double_click`、中键、`move`、`drag`、`wheel` | 单击/UIA 滚动不能覆盖拖拽、自绘内容和指针悬停 | 自有 fixture 记录真实点击次数、鼠标按钮、滚轮量和拖拽结果；越界或非目标窗口不得收到输入；释放鼠标和接管中断需验证。 |
| `screenshot --image-only` | 截图任务被无关的 UIA 遍历拖慢 | 只取画面时不遍历 UIA；生成可解码图像，尺寸与元数据匹配；保留新观察版本及坐标适用性信息。 |
| `action --observe` | 每个动作后需要额外 CLI 往返才能看到结果 | 返回单动作结果和新的 UIA 观察；相同 requestId 不再次输入；后观察失败单独报告，不能抹掉已执行动作。 |
| UIA gaps/截断说明 | provider 异常、深度或数量上限造成的缺口不够明确 | 观察标明不完整及原因；局部失败仍能保留已读取节点，不伪造完整空树。 |
| 部分输入异常后暂停 | 输入序列已经开始，异常不能被当作确定未执行 | 注入中途失败后会话暂停；回执保留未知/部分结果，不自动重复输入；已按下的键和鼠标得到释放。 |
| 服务关闭竞态 | 关闭期间正在等待的枚举/观察可能继续建立会话或发出输入 | close 与 claim/observe/action 交错时，关闭后的服务不得复活会话、继续派发或泄漏 helper。 |
| 停止快捷键可用状态 | 热键注册失败时不能承诺 Ctrl+Alt+Esc 一定有效 | `status.stopShortcutAvailable` 反映真实注册结果；不可用时仍能通过控制条停止。 |
| 真实图片与坐标验收 | 文件存在或截图 API 成功不能证明图片可用、映射正确 | 解码实际图片并检查大小/内容；由图片坐标映射到 fixture 控件，验证实际事件或持久结果；区分缩放、裁剪及窗口原始像素。 |

回归需覆盖原有行为：唯一会话、接管/恢复、停止后不能自动重启、过期观察拒绝、重复请求只执行一次、密码文本省略、无标题/不激活弹窗，以及 macOS 的不支持提示。性能对比应记录相同机器和窗口下的样本数、P50/P95及成功率；没有实测数据时只说明减少了哪些步骤，不宣称快了多少。

## 验收结果（2026-10-29）

- `npm run build` 通过，包含 Windows 原生驱动、TypeScript、CLI 和界面构建。
- `node --test tests/desktop-control.test.js tests/desktop-worker.test.js`：23 项通过。覆盖所有权、旧观察、重复请求、两处接管时序、已执行动作的后观察失败、服务关闭排队、取消等待、终止失败阻断替代进程与退出后恢复。
- 管理 CLI、工作区、Electron CLI、Skill 安装和插件打包另有 29 项相关回归通过。macOS 的验证仅是平台分支单测：明确返回 unsupported，不启动 Windows helper；没有实机 macOS 构建或原生控制验收。
- `node scripts/verify-desktop.mjs`：最终代码的 18 项原生实机验收通过。环境为 Windows `10.0.26200`、单显示器 120 DPI（125%）。证据在本机生成的 `.tools/desktop-verification/profilepilot-desktop-7oEydy/report.json`，脚本可重新生成报告和图片。
- 原生验收解码 JPEG、识别色块、从图片像素通过 captureRect 映射点击，验证真实双击、中键、移动、拖拽后的像素变化与横竖滚轮。拖动已经按下后接管，实际 MouseUp、键鼠释放、后续位移停止均通过。300 个子控件触发 `children_limit`，只截图路径返回空元素与 `uia_skipped`。
- 同一 fixture 各 3 次包含 CLI/IPC 开销的耗时：UIA 加截图为 1279.46 / 1299.70 / 1352.57 ms；只截图为 335.42 / 321.71 / 362.53 ms，中位数分别为 1299.70 和 335.42 ms。样本少，仅说明此机器和窗口下省去了遍历成本，不作为竞品速度排名。
- 实际 ProfilePilot 应用的 `ppilot desktop` 入口已验证窗口发现、compositor 截图、语义调用及 `action --observe` 返回新控件。控制条显示已注册的停止快捷键；调用停止后会话为 null。停止会同时关闭正在处理该调用的驱动，调用方可能得到未知结果；本次按状态确认停止，没有重放。

实际应用前台坐标点击曾返回 `DESKTOP_FOCUS_REQUIRED`，没有计入通过项；原生窗口点击不能保证越过 Windows 的前台或权限限制。一次旧版应用托盘右键也返回未知结果，已停止该会话而未重放。截图可以在后台读取，不代表同一窗口可以在后台接受物理输入。混合 DPI、多显示器、外部 Chromium 精确裁剪映射仍未验证。

验收过程中补充修复了两处回执/进程问题：后观察结束时的接管保留已确认输入、废弃旧观察；旧 helper 的 error 或 kill 成功返回不能当作退出证据，未确认退出时拒绝新驱动输入。主控制台也会刷新被其他窗口覆盖时的会话状态，避免后台截图长期显示已结束的任务。

## 后续范围

暂不把 WGC、完整批处理、区域原图/zoom、应用启动目录、硬件输入自动接管、OCR/视觉识别、macOS 原生驱动或模型 API 集成算入本轮交付。多屏及混合 DPI 仍需要实机矩阵验证。拖拽当前限定在所选窗口内，使用固定时长，未提供跨窗口拖拽或鼠标修饰键组合。它们需要各自的协议和环境验收。REA 的设计可借鉴；若以后复制其 [MIT 许可](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/LICENSE) 下的实质代码，应保留对应声明，并单独审查 [第三方依赖说明](https://github.com/morluto/rea/blob/8188497f13477918f2b696689c3598b65f11a7c5/THIRD_PARTY_NOTICES.md)。
