# 浏览器执行器与任务恢复

## 2026-09-22 的实现选择

应用内任务固定调用随安装包分发的 agent-browser 0.34.0 原生执行器，通过已有 Wrapper 和 ProfilePilot Gateway 使用目标 Profile。用户无需全局安装 agent-browser、Node 或 npm；应用任务也不再从 PATH 或 npx 缓存选择浏览器执行器。外部 Agent 的 CLI 集成仍保持原来的行为。

依赖版本和包完整性锁定在 package-lock.json。Windows 安装包携带 x64 执行器；macOS 安装包携带 Darwin 执行器。打包前检查目标文件，随包保存 Apache-2.0 和上游 a11y 相关许可证。任务适配器仍通过 BrowserAdapter 隔离，Jev 和主模型调用相同的任务服务，后续可以替换执行器。

这消除了终端用户的独立安装和全局版本依赖，应用本身仍依赖上游执行器。没有把上游 Rust 代码改写为 TypeScript，也没有声称完全移除第三方依赖。

## 对照的上游实现

- [agent-browser](https://github.com/vercel-labs/agent-browser)：当前核心位于 cli/src/native，使用 Rust 实现浏览器会话、CDP、页面快照和动作。直接复制核心需要维护另一套 Rust 构建及上游补丁；保留原生运行时并隔离调用边界更适合当前 Electron 应用。
- [Browser Use 的 BrowserSession](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/session.py)：Python 通过 cdp_use 的 CDPClient 管理浏览器目标和会话，结合事件与页面状态处理。接入整个项目会引入 Python 运行时和另一套会话生命周期，不能自动解决本应用的 Gateway 独占与人工交还要求。
- [Browser Use Jev Ultrafast](https://github.com/browser-use/jev-ultrafast)：从页面生成编号控件，Jev 选择动作和目标，文字生成按需调用辅助模型。ProfilePilot 已参考这一设计独立实现快速路径；它不是完整 Browser Use 的替代品，不能把演示成绩当作复杂网站可靠性保证。

## 本次流程修正

- 快速路径支持四个滚动方向，错误方向明确拒绝；观察包含视口及文档宽度，控件标记是否在视口外，并补充图像替代文字和 SVG 标题作为名称。
- 人工接管保存原因及页面地址，交还保存用户补充；在任何新导航之前强制重新观察。提示模型通过账号入口或记录页核查登录，保留用户已经完成的步骤。
- 重复动作检测不再包含模型可随意更换的 summary。相同页面、相同动作反复尝试，或在同一页面反复换动作仍无进展，会转为人工检查；页面确实变化时允许重复分页等操作。
- 取消保留最后尝试、已核实的逐项依据和待处理事项，不把点击成功写成业务成功。
- Jev 保存逐次决策、置信度、转交原因和耗时；平均响应的分母使用已有响应数，进行中或中断调用不再拉低平均值。旧任务只能显示其已有汇总，无法补出历史明细。
- 任务页优先展示待处理卡片和当前执行阶段；数字与单位成组显示；状态更新保留日志滚动、表单焦点和中文输入，操作请求显示等待反馈，暂停、接管和取消仍可使用。

## 实时浏览器现场与模型名称

- 任务页通过 Gateway 的内部鉴权连接订阅 `Page.startScreencast`，在 Canvas 持续绘制页面帧。没有截图轮询；画面不写入任务 JSON、磁盘截图或模型上下文。传输限制到 10 帧/秒、1280×900 以内，渲染端确认收到上一帧后才发送下一帧，忙碌时只保留最新待发送帧。
- 预览绑定任务的 Profile、逻辑端口、Session 和 Gateway 已记录的 Agent 标签页，不选择任意第一个标签页。用户接管后仍可看画面；不会获取 Agent 租约、模拟输入或激活原生窗口。任务结束、切换任务、页面隐藏或关闭窗口时释放采集连接；断线会提示并重连。
- Chrome 后台标签页默认可能不产生视频帧；预览连接使用 `Emulation.setFocusEmulationEnabled` 保持后台渲染。此选项暂时影响网页读取到的焦点和可见性，关闭或断开预览时恢复，不改变操作系统窗口焦点。实现依据：[Chromium EmulationHandler](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/emulation_handler.cc)。
- 主模型的准确配置 ID、服务 origin 和开始使用时间在实际执行入口保存。界面显示可识别的模型品牌与完整 ID；历史任务不会随当前设置改变。旧任务未保存的实际模型不补猜，进行中的旧任务单独标注“当前配置”。这记录的是 API 请求的模型 ID，不能验证代理服务内部是否改路由。
- 新增真实 Chrome 连续帧、后台渲染、人工接管、交还、跨会话隔离、慢渲染背压以及 Electron 实时 Canvas 测试；验证画面变化不依赖 Agent 观察或模型调用，快照更新保留 Canvas 和输入焦点。相关单元回归共 100 项通过。实际验证平台为 Windows；macOS 使用同一 Gateway/CDP 路径，未做实机验收。

## 此前执行器验证

使用任务回归测试、隔离 Electron 界面测试、通过 Gateway 的本地真实 Chrome 表单验证及 Windows 安装目录验证。没有向真实招聘网站提交数据，也没有把本地测试等同于再次完成小红书任务。macOS 路径和打包规则有检查，当前机器无法做 macOS 实机验证。

本次验证结果：98 项相关测试通过，桌面基础交互及日志滚动、焦点、中文输入、决策明细测试通过。真实 Chrome 表单测试首次出现底层连接读取超时；加入命令跟踪后完整复测通过，超时原因尚未确认，不将复测成功视为消除间歇故障。独立的横向溢出、图片头像名称和原生点击测试通过。Windows 安装目录生成成功，其中的原生执行器在空 PATH 下可独立运行。Jev 服务本身的网络/推理延迟没有重新测量。
