# 浏览器任务验证记录

验证环境：Windows 11、Node 22、Electron 42.3.3、Claude Agent SDK 0.3.278、agent-browser 0.34.0。

## 自动化入口

先运行 `npm run build`。以下命令分别验证不同层级：

| 命令 | 覆盖范围 |
| --- | --- |
| `node --test tests/browser-tasks.test.js tests/browser-task-ipc.test.js` | 41 项：持久化、权限、确认竞争、恢复、队列、调度、文件边界、PDF、SDK 配置/打包路径、通知回调 |
| `node scripts/e2e-browser-tasks.mjs` | 桌面真实 preload/IPC、资料、任务、取消、所选项续办、模板、计划、搜索、设置 |
| `node scripts/verify-sdk-runtime.mjs` | 真实 SDK 进程连接本地脚本化 Anthropic 端点；受控工具及 Read 授权 |
| `node scripts/verify-task-integration.mjs` | TaskService → SDK → MCP → Gateway → Chrome → 本地 HTTP 站点 → CSV |
| `node scripts/verify-task-recovery.mjs` | 站点提交后截断响应，退出、重载、恢复同一个 SDK 会话、查询记录，无重复提交 |
| `node scripts/verify-task-provider.mjs` | 读取系统加密凭据，向当前模型服务发起真实 SDK 一轮请求；会产生少量 API 用量 |
| `node scripts/verify-task-live.mjs` | 真实模型自主填写、上传、动态表单、授权提交、核验及 CSV 导出；会产生 API 用量 |
| `node scripts/verify-task-live-batch.mjs` | 真实模型读取三行 CSV，两项提交、一项缺字段失败、核验逐项导出 |
| `node scripts/verify-task-live-handoff.mjs` | 真实模型准备订单、交还用户、浮层接收器在线、交还事件恢复 SDK、核查回执 |
| `node scripts/verify-task-baseline.mjs` | 同模型/SDK/浏览器适配器的普通 Agent 对照，无 TaskService 持久流程 |
| `node scripts/verify-task-pdf.mjs` | 已选择 PDF 的本地文字/页图提取、真实 SDK 和 Kimi 接收；支持 PP_VERIFY_PACKAGED=1 |
| `node scripts/verify-task-browser.mjs` | 真浏览器上传/下载、动态表单、用户接管与恢复 |
| `node scripts/run-tests.mjs --test-reporter=dot` | 仓库既有全部测试入口 |

集成和恢复测试会新建专用 Profile 与 Gateway，不使用用户已有端口、账号或登录态。测试 Chrome 仍通过正式 wrapper/Gateway 驱动，不直连 CDP。Windows 保留原 USERPROFILE/APPDATA，避免输入法及 Chrome 因 Shell 目录改变而启动失败。测试结束关闭自己的浏览器和 Gateway；被第三方输入法暂时占用的临时目录会输出路径并保留，不强行递归重试。

模型凭据通过 Electron safeStorage 解密后仅在私有子进程 IPC 中传递，既不放入命令行参数，也不写入报告。所有浏览器数据均为本地验收站的虚构资料，不进行真实投递或交易。

## Windows 安装包验证

运行 `npx electron-builder --win --dir --publish never` 生成 `release/win-unpacked`。

在 PowerShell 中设置 `$env:PP_VERIFY_PACKAGED='1'`，再运行 `node scripts/verify-task-provider.mjs`，使用打包后的运行时和 ASAR 内的 worker 调用真实 SDK。原生 SDK 可执行文件需映射到 `app.asar.unpacked`，不能直接以虚拟 ASAR 路径启动。

已实测打包后的 worker 通过 Kimi K3 返回“连接成功”。这项检查不等同于完整安装/卸载、macOS 签名或公证验证。

## 证据与结论边界

本机产物在 `test-results/browser-tasks/`，文件不含密钥：

- `desktop-result.json`、`workspace.png`、`settings.png`：桌面交互证据。
- `sdk-transport-result.json`：脚本化端点的真实 SDK 工具调用，不能当作真实模型效果。
- `gateway-browser-result.json`：实际浏览器填写、上传、下载、动态页面、接管与交还。
- `recovery-result.json`：提交只产生一条服务端记录；恢复后的累计用量与同一 SDK 会话一致。
- `provider-result.json`、`provider-packaged-result.json`：开发与打包运行时的真实 Kimi 连接。
- `live-task-result.json`：真实模型任务的状态、服务端记录、用量、时间、事件及结果。必须检查 `passed`，不能仅凭文件存在认定通过。
- `live-batch-result.json`、`live-batch-output.csv`：混合成功/失败，服务端恰好两条记录，三项导出内容已校验。
- `live-handoff-result.json`：接管时零条订单、Agent 不提交；测试用户完成后通过 Gateway 交还，恢复并核查一条订单。没有真实支付。
- `baseline-result.json`、`baseline-output.csv`：普通 SDK 对照的服务端结果与导出校验。
- `pdf-result.json`、`pdf-packaged-result.json`：本地 PDF 文字与页图经真实 SDK 传给 Kimi；Windows 打包测试使用 ASAR 内的解析器和原生渲染模块。

Kimi 当前配置依据：[官方 Claude Code 接入文档](https://platform.kimi.com/docs/guide/claude-code-kimi)。Base URL 为 `https://api.moonshot.cn/anthropic`，模型为 `kimi-k3`。SDK 费用是其估算值，不代替 Kimi 账单，也不能作为不同服务商间的可靠价格比较。

## 真实模型样本与普通 SDK 对照

2026-09-19，Kimi K3，均使用本地虚构站点。耗时使用脚本端到端墙钟时间，费用仅为 SDK 报告估算。

| 样本 | 结果 | 耗时 | 浏览器动作 | SDK 费用估算（美元） |
| --- | --- | --- | --- | --- |
| 工作台招聘表单 | 完成；服务端一次提交，核查记录并导出 | 260.5 秒 | 10 | 0.312224 |
| 普通 SDK 招聘基线 | 完成；相同字段/附件、一次提交，核查记录并导出 | 148.8 秒 | 10 | 0.125141 |
| 工作台三项批量 | 两项成功，一项缺邮箱失败；总体部分完成，符合预期 | 322.1 秒 | 14 | 0.351501 |
| 工作台购物接管 | 填写后交还，测试用户提交，恢复核查 | 134.1 秒 | 6 | 0.065486 |

招聘对照使用相同模型、SDK、浏览器适配器、字段、授权和结果标准，各执行一次；工作台包含更多流程工具与状态上下文。两者均无执行中人工介入。普通 SDK 在这个样本中更快、SDK 估算费用更低，不能宣称本产品的执行效率优于通用 Agent。产品已验证的收益是给普通用户提供资料、账号、授权、接管、批量结果、调度与中断恢复管理。

这是单样本开发验收，不是统计基准，也没有与 Codex 或 Browser Use 做直接性能对照。真实网站的验证码、风控、登录、多页面复杂业务，以及通知系统层交互、macOS 安装/运行仍需对应环境验证。

PDF 采用 [Mozilla PDF.js](https://mozilla.github.io/pdf.js/getting_started/) 本地解析，避免 Kimi 拒绝原生 PDF `document` 块。扫描页以图像提供，不执行嵌入脚本，不自动读取 PDF 外链；文字截断和下一页信息明确返回。生产依赖审计为 0 项已知漏洞；开发构建依赖仍有既存审计告警，未在本次任务中进行无关大版本升级。

## 旧 Gateway 的兼容处理

协议 15 修复 Windows 下载目录的长路径前缀。已有 Gateway 持有真实 Chrome 管道时，升级会延后，不能为更新程序强关用户窗口。旧版本下下载会明确提示先关闭 ProfilePilot 浏览器窗口；全部窗口自然关闭后，下一次准备浏览器会更新 Gateway。其他任务操作仍可继续。
