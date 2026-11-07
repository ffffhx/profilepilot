# Agent 业务任务回归集

`1.1.1` 将受控恢复任务的输出枚举写进公开题面（fixture `recovery-1.0.1`），避免用未声明的字段取值判错；早期 `recovery-1.0.0` 记录保留，不与新版合并。真实站点准备等待页面和视口连续稳定后再校验，环境不符时保留原因，不进入模型执行。

本评测集用于大更新前后的业务回归、指定真实站点的只读验收，以及受限状态下的恢复处理。入口在 `benchmarks/agent-tasks/`，任务目录版本为 `1.1.1`。仓库中的任务模板和示例配置不包含用户历史会话、真实 Profile ID、账号绑定或凭据；真实站点运行使用单独保存在本机的环境配置。

`ready` 表示对应任务和判分入口已实现，不表示某个模型或工具已通过，也不表示当前机器已满足运行条件。当前有 27 个任务模板：8 个合成浏览器任务、2 个需本地账号与 Profile 绑定的真实网站只读任务、1 个受控登录过期任务，其余 16 个为 `planned`。手机、桌面及跨平台业务任务尚未就绪。

三组独立选择、独立计分，默认只运行 `synthetic`：

| 分组 | 环境与任务 | 成功含义 |
| --- | --- | --- |
| `synthetic` | localhost 合成门户；每单元新建 fixture 和隔离 Gateway Profile | 业务终态与全部约束通过 |
| `live-site` | 固定 GitHub 页面；显式绑定已有登录态的扩展 Profile | 本次日期和环境下的只读验收通过，不提供公平排行榜 |
| `recovery` | localhost 受保护页面；应用会话被初始化为过期，使用隔离 Gateway Profile | 正确识别阻塞并请求用户在原 Profile 登录，不表示业务完成或已恢复登录 |

| 合成任务 | 核验目标 |
| --- | --- |
| 简历同步 | 授权字段、附件真实内容、已有申请不变 |
| 校招投递 | 指定岗位与志愿顺序、唯一正式申请 |
| 商品筛选 | SKU、预算、兼容性与候选数量，无购买 |
| 租房比较 | 日期、费用、通勤口径与候选数量，无联系或预订 |
| 已批准邮件 | 任务中既有批准版本单次发送，回包丢失后先查已发送 |
| 福利领取 | 实际余额及作用范围，无付费 |
| 云资源退款 | 正确资源、实际退款终态，其他资源保留 |
| OA 文件提交 | 正确文件内容、唯一提交记录，区分提交与审核 |

每个合成任务有 `1101`、`2202`、`3303` 三个数据 seed。合成 `baseline` 共 24 个单元；邮件另有 `commit-response-loss` 条件的 3 个单元。两个真实站点任务和受控恢复任务都固定为 seed `0`，不能用任意 seed 伪造不同数据样本；可用 `--repeat` 预登记多次运行。数据 seed、生命周期条件和重复试次分别记录，不混入其他分组的分母。计划在执行前固定，失败、阻塞、超时、环境异常和未运行单元都保留。

合成组使用简化的本地页面。附件是 UTF-8 `.txt`，核对真实上传 bytes 的 SHA256；没有实现 PDF/DOCX 解析或独立下载回读。审批是任务 prompt 中的一次静态授权，不包含“先起草、用户修改、再批准”的动态 actor，也没有用户接管状态机。相应扩展在目录的 `plannedExtensions.status: not_implemented` 中列出，不能把它们当作当前覆盖。

写入任务要求唯一业务记录、实际结果读取及最终结构化回答与后台状态一致。福利任务必须到账后回读钱包，不能用活动受理回执代替；其他写入任务要求对应回执详情。商品与房源任务要求两个符合条件的候选并逐项读取详情。邮件恢复条件会在首次发送已落库后断开响应；重新读已发送详情可以完成核验，重复发送会失败。当前 oracle 检查规定的 JSON 字段与后台状态，不对额外自由文本做全面语义审查；例如 OA 的 `status: approved` 会失败，但附加文字中的夸大还没有 NLP 判分。

## 命令

```sh
npm run eval:list
npm run eval:smoke
npm run eval:smoke -- --group recovery
npm run eval:run -- --adapter benchmarks/agent-tasks/adapters/profilepilot-sdk.json
npm run eval:run -- --group live-site --environment test-results/agent-tasks/local/environment.json
npm run eval:report -- --run <run-directory>
npm run eval:compare -- --before <before-run-directory> --after <after-run-directory> --mode revision
npm run eval:serve -- --run <run-directory> --detach
```

`eval:smoke` 验证 fixture、reset、判分与报告链路；参考驱动的通过数不能称为模型成功率或 ProfilePilot 的浏览器能力成绩。真实 Agent 运行使用适配器并记录模型、工具及版本、平台、预算、准备方式和任务单元集合。适配器及命令参数以当前入口的 `--help` 为准。

### 准备和成本

使用 Node.js 22 或更新版本并安装本项目依赖。`eval:smoke` 只运行本地 HTTP fixture 和确定性参考驱动，不调用模型或浏览器。`eval:run` 的内置适配器还需要已构建的 `dist/main/profilepilot-cli.cjs`、浏览器执行器及项目运行模块、本机 Chrome，以及 ProfilePilot 任务设置中可用的模型配置和加密凭据。按项目构建流程准备后，先运行一个单元确认环境；不要用完整 24 单元任务集排查缺失依赖。

内置适配器通过 Electron 凭据助手读取已有任务模型设置，密钥不写入 Agent 的任务文件；可用 `PP_TASK_PROVIDER_ROOT` 指定已有任务配置目录。模型名称与工具版本以实际回包记录，配置值另保存在冻结的 manifest 中。默认合成组与受控恢复组使用一次性的 Gateway Profile；只有显式选择 `live-site` 并提供有效本地绑定，才会使用指定已有 Profile 的扩展连接，不自动选择默认 Profile。

隔离 Gateway 使用显式的 `PROFILEPILOT_GATEWAY_HOME`。wrapper 的发现、租约、控制通知和会话状态优先使用该目录，随后才回退到已有 `HOME` 和系统用户目录；测试无需改写系统 HOME。原生浏览器驱动自己的配置搜索仍按其平台规则执行。若使用旧构建，需重新构建 wrapper 与 CLI 才能获得这一隔离修复。

Windows 的隔离 Gateway 通过独立 worker 启动，避免临时终端 Job 影响 Chrome；macOS 使用 detached worker。两者仍经 Gateway 管理测试 Profile，默认 headless，运行记录包含本次 Chrome 可执行文件的版本。Windows 链路已在本机验收，macOS 真实浏览器链路尚未实机验收。

若 Windows 的超长 PATH 使 npm 子 shell 报 `node is not recognized`，可在能直接运行 Node 的终端使用等价入口，例如 `node benchmarks/agent-tasks/run.mjs list`、`node benchmarks/agent-tasks/run.mjs smoke`。无需为了运行评测永久修改系统环境。

```sh
# 单个真实模型单元
npm run eval:run -- --tasks career-resume-sync --seeds 1101 --timeout-ms 240000 --max-actions 80 --max-budget-usd 1
# 邮件已提交但响应丢失；独立于baseline
npm run eval:run -- --tasks mail-approved-reply --seeds 1101,2202,3303 --condition commit-response-loss
# 预登记重复试次，全部结果保留，不采用pass-at-k
npm run eval:run -- --tasks shopping-sku-compare --seeds 1101 --repeat 3
```

默认每个单元的执行预算为 240 秒、80 次模型发起的浏览器操作、1 美元模型预算；准备时间另记。适配器内部的所有权/URL 检查是额外 CLI 调用，不能把该动作预算解释为总进程调用数。24 个基线单元的模型预算合计最高 24 美元，另跑 3 个邮件恢复单元为额外 3 美元；这是配置预算，不是费用承诺。实际成本取 SDK 估算并逐单元记录，缺失用未知表示，不能当零费用。外部适配器须遵守动作和费用预算；runner 的进程超时不等于对外部服务实施费用硬限制。

运行默认写入 `test-results/agent-tasks/<run-id>/`，包含执行前冻结的 `manifest.json`、持续更新的 `report.json`/`report.html` 和各单元证据。`--output` 必须指向新的目录，不能覆盖旧运行。`eval:report` 从已有结果重新生成报告，不重跑 Agent。预览仅监听本机，`--detach` 独立启动并检查进程仍存活，只提供报告文件。

### 真实网站的固定环境与登录态

当前只实现两个只读任务，必须使用 `--group live-site`：

| 任务 ID | 固定页面 | 独立核验 |
| --- | --- | --- |
| `live-github-account-review` | `https://github.com/settings/profile` | 当前登录账号的公开用户名、姓名、简介、所在地，与 GitHub 公共用户 API 核对 |
| `live-github-issue-read` | `https://github.com/microsoft/TypeScript/issues/1` | issue 编号、标题、状态、作者、完整标签和 URL，与 GitHub 公共 issue API 核对 |

第二题的内容虽然公开可读，仍要求指定已登录 Profile，以验收日常扩展控制路线。Agent 只能读取页面；独立公共 API 由 host 判分器使用，不作为 Agent 的捷径。两题都禁止编辑、保存、评论和其他业务写入。运行前后独立 API 数据改变、来源限流、登录失效或身份改变时，记为 `environment_invalid`，不能归因于模型答错。

将 [环境示例](../benchmarks/agent-tasks/environments.example.json) 复制到本地忽略目录，例如 `test-results/agent-tasks/local/environment.json`；字段定义见 [环境 schema](../benchmarks/agent-tasks/environments.schema.json)。示例的 `REPLACE_*` 故意无效，不能直接当成已完成环境准备。文件包含三部分：

- `environments`：以任务 ID 为键的公开合同，固定 `track`、`siteId`、精确 `startUrl`、`allowedOrigins`、Profile 策略与别名、登录要求、连接方式和扩展 ID/版本、OS/架构/系统版本、浏览器名称/版本/模式、viewport/DPR、locale、timezone、网络方式与出口别名。
- `bindings`：只在本机保存 `profiles[别名] = 实际 Profile ID` 与 `accounts[别名] = {siteId, identitySha256}`。GitHub 的 identity 摘要按独立确认的登录用户名转小写后计算 SHA256；它是身份匹配信息，不能当作登录凭据或发布到公共报告。
- `attestation`：人工核对记录，包含 `checkedAt` 的 ISO 时间、`extensionId`、`network: {mode, egressAlias}`，有效期最多 24 小时。不要填写代理密码、Cookie、Token 或浏览器 storage 内容。

当前 CLI 状态可读回扩展版本，**不能自动证明扩展 ID 或系统代理/出口配置**。这两项使用操作者近期登记，明确标为人工证据；不能把配置值复制为所谓自动检测结果。浏览器版本、页面 viewport/DPR、语言与时区来自运行中的页面，OS 信息来自 host。示例中的尺寸和语言只是预登记值，必须与实测一致，不会因为示例写了这些值就自动调整浏览器。

这里固定的是 ProfilePilot 连接扩展；其他浏览器扩展的完整清单尚未自动核验，也是本版真实网站成绩只作为验收记录的限制。运行前会把通过 schema 校验的公开环境合同冻结进 manifest；本地身份绑定不会复制到公共报告。

首次登记也要使用与运行时相同的逐题会话流程：指定 Profile → claim 新任务标签页 → 核验登录 → 打开该题入口 → 等待两次稳定读回 → complete。不要只在一个标签页测一次尺寸，再复制给全部任务；浏览器控制提示等界面状态可能改变页面的可用高度。每题分别固定实际 viewport，运行时不自动改写约定来迁就测量值。

host 在任务开始前以独立步骤打开已登录资料页，读取当前身份，再进入固定任务页。`checkPreparedEnvironment` 校验 Profile 绑定、账号摘要、证据的站点/origin/Profile、登录证据时间和所有固定参数。`login.maxEvidenceAgeSeconds` 限制登录证据的新鲜度；这是每次预检的独立读回，不能被 24 小时的人工网络登记替代。字段缺失、错账号、过期证据、参数漂移或连接不一致均返回 `environment_invalid` 原因，不把它写成业务失败。此校验模块只检查可信准备器提供的证据，本身不建立登录、不连接浏览器，也不接受任务 Agent 的自述充当预检。

真实网站合同使用 `profile.strategy: reuse`、`login.state: preauthenticated`、`transport.kind: extension`。登录态和任务数据分开管理：`taskData.authReset` 固定为 `forbidden`，不得通过清 Cookie、注销或替换 Profile 重置业务数据。本版真实任务为 `read-only`，清理只完成自己拥有的控制会话并保留 Profile 与登录，不删除已有标签、账号数据或其他人的会话。预检发现占用或用户接管时停止，不自动 resume。通用合同也支持 `fresh` 和 `gateway`，但不代表这两个 GitHub 任务接受这些替代方式。

公开合同 URL 不得带用户名密码、query 或 fragment，以免凭据进入任务与报告。真实 Profile ID 和身份摘要不出现在环境公共摘要中；已有账号的公开资料及 Agent 答案仍可能出现在本地任务证据里，分享报告前应按实际内容审阅。本地 binding 文件不应提交到仓库。

```sh
# 只运行指定已登录账号的公开资料核对；先完整填写本地环境文件
npm run eval:run -- --group live-site --tasks live-github-account-review --environment test-results/agent-tasks/local/environment.json
# 同一固定站点场景的三次预登记验收，不伪造随机数据 seed
npm run eval:run -- --group live-site --tasks live-github-issue-read --environment test-results/agent-tasks/local/environment.json --repeat 3
```

真实网站结果是带日期、账号内容与人工登记前提的 **acceptance 记录**。固定 URL、版本和 viewport 不能冻结服务端部署、AB 实验、页面内容或网络状态；本版比较入口拒绝把 `live-site` 运行用于自动排名，不给跨工具胜负或成功率涨幅结论，也不与合成组相加。

### 受控登录过期

`recovery-login-expired` 只在本地 fixture 中把应用会话初始化为过期，不注销真实网站账号。Agent 需要先读取受保护页面，报告登录阻塞，请求用户在原 Profile 登录，保留状态；不得猜测最近提交事实、尝试凭据或改用另一个 Profile。

```sh
npm run eval:smoke -- --group recovery
npm run eval:run -- --group recovery --tasks recovery-login-expired --repeat 3
```

这一组固定 seed `0`。oracle 的通过表示正确处理受限状态，报告单独展示“正确处理 / 计划”；它不表示用户已经登录、会话已经恢复或原业务已经完成。真实任务在预检时意外登录过期属于环境失效，只有明确选择 recovery 场景时，识别过期本身才是测试目标。

### 接入其他 Agent 或工具

当前只内置 ProfilePilot 的 SDK 适配器，没有现成的竞品适配器。以下协议是接入扩展点，不代表第三方工具已经接入、运行或完成公平性验证。

`--adapter` 接受 JSON 配置，runner 以参数数组启动进程，不使用 shell 拼接。示例：

```json
{
  "protocolVersion": 1,
  "id": "other-browser-driver",
  "agent": "same-agent-implementation",
  "model": "exact-model-version",
  "tool": "other-browser-tool",
  "toolVersion": "exact-tool-version",
  "track": "matched-browser-dom",
  "environment": "external-browser",
  "command": "$NODE",
  "args": ["$REPO/path/to/adapter.mjs"]
}
```

进程从 stdin 接收一行 JSON，包含 `protocolVersion: 1`、任务 URL/公开 prompt/附件、独立工作目录、预算及允许的环境信息。stdout 必须只输出一行结果 JSON，日志写 stderr。结果含 `protocolVersion: 1`、`status: completed|failed|blocked`、`answer`、`usage` 和 `metadata`；`completed` 只是适配器完成声明，最终通过由 oracle 判定。`usage` 记录 `inputTokens`、`outputTokens`、`costUsd`，未知字段用 `null` 或省略；`metadata` 记录实际 `agent/model/tool/toolVersion/track`。

任务产物写入独立工作目录的 `outputs/`，支持 `.json`、`.csv`、`.txt`、`.md` 普通文件，最多 32 个、单文件 1 MiB、总计 4 MiB；不接受链接或目录。任务页面会给出所需输出格式。适配器可以返回正确阻塞并保留原因，不得为了得到完成状态绕过授权或读取私有判分文件。

工具比较需两侧真正使用相同的 Agent、模型、能力约束、预算和准备方式。`external-browser` 默认记录为 `fresh-fixture-per-cell`，内置 Gateway 为 `fresh-profile-per-cell`；现版不会自动将它们判为公平工具比较。第三方需要额外实现等价的 fresh-profile 准备、预算与工具能力契约后才可排名，不能只改元数据标签。不同模型使用 `--mode agents`，报告只作全栈比较。准备或能力不同的试探性运行仍可展示原始结果及差异，不给胜负结论。

## 结果与比较

合成业务组的主指标要求业务目标完成且全部硬约束满足；真实网站组由独立站点读取器核验指定只读事实。批准前停住、权限不足时停住、正确报告支付状态未知，属于正确处理；它们不能冒充邮件已发送、福利到账或退款完成。提交、审批、到账及公开可见等阶段分别核验。受控恢复组另以正确识别和处理阻塞为目标，不与业务完成率混用。任何组都不采用 Agent 自述或 CLI 退出码作为成功证明。

每次运行保存原始结果与 HTML 报告；缺少结果的计划单元计为 `not_run`。失败、阻塞、环境异常和超时都保留在预登记计划分母。报告将 `harness-selftest` 与 `agent-evaluation` 分开。

可复现组的比较模式包括同一 Agent/工具的大更新回归、同一 Agent 的工具比较，以及不同 Agent 的全栈比较。suite/fixture/catalog 版本与内容、分组、任务-seed-condition-repetition 集合、路线、准备方式、平台、浏览器模式/实际版本和预算必须一致。模型运行缺少浏览器元数据时不能确认可比。不同模型属于全栈差异，不能将收益单独归因于 CLI。身份仍是 `configured`、`local-build` 或未知值时，不能确认可比。不可比时仍展示原始结果和差异原因，但不排名、不计算胜负或成功率百分点变化。`live-site` 即使上述字段相同，也只保留验收记录。

`revision` 模式还要求 `adapterConfigHash` 与 `agentImplementationHash` 均存在且完全相同。后者标识适配器入口实现、SDK 版本及提示代码，防止提示或 Agent 逻辑变化被误归因于 CLI 更新；旧报告缺少这些字段时不能进行该模式的比较。工具的实际版本和 CLI 构建哈希可以变化，但不能同时悄悄改变 Agent 配置。配置哈希基于原始 JSON，保留 `$REPO` 等尚未展开的路径占位，避免仅因工作目录不同而产生差异。

runner 在结束时记录 `endRevision` 并检查所跟踪代码的哈希。任一运行的 `integrity.codeStable` 为 `false`，表示 CLI、helper、fixture、适配器或执行器等代码在运行期间改变，该结果不能参与任何模式的比较。旧报告没有此字段时不会仅因此被拒绝，但不能据此声称已验证运行期间代码稳定。

`tools` 模式允许工具适配层不同，但 Agent 提示策略、模型、公开能力规范及预算口径仍需人工审查等价。报告的契约检查不能证明这些语义条件；仅有相同 Agent 名称不足以确认公平性。`agents` 模式可以比较不同配置与实现，并明确展示全栈差异。

同模型比较工具时可以更换工具，但需要保持允许能力和预算一致；公开业务接口与专用工具按所选路线明确开放，不能把隐藏判分接口交给一方。工具名称不同不保证后端独立，需记录实际实现与版本。

## 隔离与权限

本地 runner 是协作式执行环境，**不是安全沙箱**。正常任务材料不包含私有期望答案、oracle 状态或管理令牌；但同一操作系统上有文件读取权限的 Agent 仍可能访问仓库源码。正式竞品比较需要额外的进程、文件系统、网络与凭据隔离，并由可信 runner 保管 reset、判分和 actor 通道。不得把本地协作式结果宣传为抗作弊评测。

默认合成组与受控恢复组只使用测试文件和隔离 fixture，不访问已有个人 Profile。真实站点组必须由本地配置显式绑定已授权的 Profile 与账号，并仅执行目录中规定的只读任务；不能自动选择默认 Profile、复制登录态或扩大到真实支付、发信和其他生产写入。业务内容批准与控制权是独立事件；技术恢复不会撤销内容范围未变的批准，用户接管期间不得继续输入。结果未知时先读取终态，避免重复产生业务副作用。

附件需要按真实 bytes/hash 和独立回读验证，不能只核文件名。CSV 导出需解析完整记录并按业务 ID 对齐，不能用包含关键词替代。未实现的能力不得以旧脚本通过填补。

## 已有脚本与扩展

`legacy-suites.json` 盘点现有 benchmark、可靠性回归与应用验收脚本，并记录限制；新入口不会自动执行这些脚本。组件耗时、固定动作回归、模型样例、真实站点验收和本业务任务集使用不同口径，不汇总成一个成功率。

新增合成任务时先增加公开材料、确定性 reset、独立业务 oracle 与不应改变的数据，再设为 `ready`。真实网站任务还要固定站点与允许范围，明确登录预检、身份绑定、只读/写入授权及独立站点 oracle；受控恢复任务要定义受限起点和正确停止标准。变更判分、数据生成、路线契约或任务语义时更新版本，并保存 fixture/catalog 内容哈希。Windows 与 macOS 运行分别记录；手机和桌面不能凭浏览器结果宣称覆盖。

`.github/workflows/agent-task-evals.yml` 在相关 PR 或手动触发时运行 Windows/macOS 的 `test:evals`、24 个合成基线自检、3 个邮件丢响应自检和 1 个登录过期恢复自检，并保留报告。该工作流不调用付费模型、不启动真实浏览器，也不使用真实站点账号；它不能替代发布前的真实 Agent 回归。合成组三个 seed 是小样本，若要判断稳定提升，应预登记更多 seed 或重复试次，并固定模型版本，避免把服务端模型别名的更新误认作工具收益。

## 公开评测的借鉴与边界

以下是设计借鉴，不表示已经接入、复现或完成这些公开 benchmark；本地任务成绩不能替代其官方成绩。

| 来源 | 公开设计与本项目借鉴 |
| --- | --- |
| [OSWorld 论文](https://arxiv.org/abs/2404.07972)及[官方实现](https://github.com/xlang-ai/OSWorld) | OSWorld 支持任务设置与基于执行结果的核验。这里借鉴准备、执行、判分分离，以及保留具体环境和运行证据；没有把本地浏览器任务等同于完整 OS 操作能力。 |
| [WebArena 论文](https://arxiv.org/abs/2307.13854)及[官方实现](https://github.com/web-arena-x/webarena) | WebArena 使用可自行部署的网页环境，并评估任务完成的功能正确性。这里以可重置合成站点作为主要回归集，用独立状态核验业务结果。 |
| [WebVoyager 官方实现](https://github.com/MinorJerry/WebVoyager) | WebVoyager 面向真实在线网站，仓库明确部分任务需要更新日期。这里保留真实站点验收，但记录时间、登录和环境，拒绝把在线漂移伪装成可完全复现的排行榜。 |
| [AndroidWorld 官方项目](https://google-research.github.io/android_world/)及[论文](https://arxiv.org/abs/2405.14573) | AndroidWorld 采用参数化任务、初始化/成功检查/清理以及系统状态奖励。这里借鉴 seed 变体与独立状态 oracle；真实网站固定场景不会通过改 seed 冒充新样本，Android 任务仍未实现。 |
| [Windows Agent Arena 官方实现](https://github.com/microsoft/WindowsAgentArena) | WAA 使用可复现 Windows 环境、镜像和明确实验配置。这里固定 OS、浏览器、显示参数和网络条件，并区分 Windows/macOS 验收；没有实现其 VM 镜像或 Azure 并行框架。 |

`1.0.1` 修正了邮件丢响应条件：提交后先发送 HTTP 响应头与部分 JSON，再截断正文，避免 Chrome 在尚未收到响应时透明重试 POST。早期 `1.0.0` 的这项扰动记录只用于排查测试环境，不用于认定 Agent 主动重复发送；保留原始运行，不与修正后的任务合并计算。
