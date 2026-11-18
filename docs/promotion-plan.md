# ProfilePilot 推广方案与文案修订版

**执行更新（2026-11-15）：** 视频由作者自行制作。本轮非视频成果已整理到 [推广材料包](promotion-launch/index.html)：渠道文案、10 张配图、官网与中英文上手页、扩展提交材料、反馈表单和试用记录。发布测试的三处问题已在本地修复，相关 24 项测试通过；[完成项与发布前条件](promotion-launch/release-readiness.md)逐项记录。下文早期清单保留为策划依据，以材料包的状态和文案为准。

更新于 2026-11-15。接续 [Claude 原文](https://claude.ai/artifact/ED7tdyEE9Zm3Pisg8Ly8Ee)，另有 [原稿存档](promotion-plan-claude-original.md)。本版已写入对 browser-use、agent-browser 的比较，并按用户确认，将并行定义为**不同 Profile／应用各自运行**。云端原文尚未回写。

**建议主打：让已经在用 Claude Code／Codex 的人，直接完成自己电脑上的网页和手机任务。** 最值得展示的是网站适配带来的具体结果、多个独立目标的会话管理，以及浏览器、Electron、安卓的统一入口。开源、复用登录态、支持 CLI 和多会话都值得介绍，但不足以单独解释为什么选择 ProfilePilot。

下文产品能力以当前本地源码与 CLI 为准；发布前应先让下载版具备演示中的能力。推广主线不包含内置 Agent、Windows 桌面控制、GPUI 或远程电脑。

## 一句话介绍与使用理由

**一句话介绍：** ProfilePilot 是给 Claude Code、Codex 等 Agent 使用的本地工具，通过一个 CLI 操作已登录的 Chrome、Electron 应用和安卓手机，并为闲鱼、小红书等网站提供现成的数据读取能力。

**回答“为什么不用 Star 更多的工具”：** 如果你经常让 Agent 在闲鱼筛商品、整理小红书资料，还要检查自己的网页或安卓 App，ProfilePilot 把网站读取、结果整理、目标选择和人工接管放在同一套工具里，能少维护一些站点脚本和连接配置。是否值得换，用这几项真实任务的结果判断。

最适合先争取的用户：已有本地编程 Agent、经常处理登录后网页事务、愿意试用早期工具的开发者。第二批是需要多账号 Profile 和手机验收的人。大规模云端并发、成熟浏览器测试流水线并非首发重点。

## 优先讲清的四项价值

### 1. 网站适配能交付具体结果

当前 CLI 列出 **9 个站点、21 项结构化读取操作**：闲鱼、BOSS 直聘、Bilibili、知乎、什么值得买、Reddit、小红书、搜狗微信与微信公众号、YouTube。各站能力不同，不是每站都支持搜索、详情、评论全部功能。来源：[操作目录](../src/main/site-adapters/catalog.ts)、[网站适配说明](site-adapters.md)。

通用网页工具给 Agent 页面、元素和点击能力；这里另外提供命名清楚的站点操作及约定好的结果格式。用户能得到商品、价格、原链接、筛选条件是否生效、是否只读到部分内容等信息。失败与空结果分开，适合继续筛选、核对和整理。

**最强演示选闲鱼：** 给出预算和内存规格，搜索候选，读取详情，标出不符合项和待确认项，生成带来源的对比报告；之后再次采样还能比较挂牌价变化。价格历史从实际采样开始，不会自动补齐过去一年。来源：[闲鱼工作流](xianyu-adapters.md)。

小红书可展示按条件搜索、读笔记详情与已加载评论；只读到的评论不能说成全部评论。YouTube 字幕读取使用已有字幕，不等于音频转写。

**X 的范围：** 当前 `ppilot browser sites` 与源码没有 X／Twitter 专用操作。普通浏览器功能可以操作 X 页面，但本版不把它列为内置站点适配。若相关实现位于其他分支或个人 Skill，应单独确认分发方式与验收结果。

### 2. 多 Agent 分别管理自己的目标

准确表述是：**不同 Agent 可以分别在不同 Profile／应用中工作；同一受控目标有明确归属，发生占用时停止并报告。**

演示可以让 Agent A 使用“资料收集 Profile”，Agent B 使用“开发测试 Profile”，旁边保留用户自己的工作窗口。让观众看到任务名称、目标和控制状态，再展示结束其中一个任务后另一个任务仍在运行。

扩展连接和 Gateway 当前都按 Profile 维护唯一控制会话；同一 Profile 的第二个会话会报冲突。不能写成“任意多个 Agent 在同一 Profile 的不同标签页同时控制”。跨应用并行也要遵守各后端的控制范围，不能推广为多个 Agent 同时操作同一台手机或共享桌面鼠标。来源：[扩展会话检查](../src/main/native-control/service.ts)、[Gateway 控制权](../src/main/browser-gateway-control.ts)、[冲突测试](../tests/native-control-lifecycle.test.js)。

这项价值的重点是**目标和控制权容易管理**。多会话本身并非独有，agent-browser 已有隔离会话及共享浏览器的标签页锁定，见下表。

### 3. 日常 Chrome 的连接和人工接管形成完整流程

已连接的扩展可以沿用当前 Chrome Profile 的页面与登录态。普通网页操作不要求重启 Chrome、复制 Profile 或手动开放浏览器调试端口。独立浏览器服务可在桌面 App 关闭后继续服务外部 CLI；首次仍需安装并配对。来源：[连接与更新](system-chrome-onboarding.md)、[浏览器 CLI](native-control-cli.md)。

常规网页读取、输入和截图支持后台完成；遇到系统对话框、浏览器内部页等情况另有平台限制。暂停／接管后拒绝后续输入，交还后重新观察；断线和结果不明时不自动重放。对用户的价值是遇到登录、验证码或临时人工处理时，知道如何接手。

推广中应演示“我接管后它确实停下”，不要只展示一个暂停按钮，也不要承诺所有应用、所有操作都不会占用前台。

### 4. 同一套工具覆盖网页、Electron 和安卓

`ppilot browser`、`ppilot electron`、`ppilot phone` 配合统一分发的 Skill，让 Agent 发现目标、检查连接、取得会话、执行并结束。适合“改网页 → 浏览器检查 → Electron／安卓验收”这类跨目标工作。

这项价值在于统一准备和日常使用，不代表底层协议完全相同，也不代表竞品不能操作 Electron。agent-browser 已提供 Electron Skill 和 iOS Safari 自动化说明；**安卓 App 控制与本地设备管理的组合**更适合作为补充演示。来源：[ProfilePilot Skill](../skills/profilepilot/SKILL.md)、[agent-browser Skills](https://agent-browser.dev/skills)、[iOS 说明](https://agent-browser.dev/ios)。

外部控制命令不额外启动内置模型循环；用户继续使用自己的 Agent。两款竞品也有面向外部 Agent 的工具入口，因此“不绑定模型”属于接入便利，不是独有优势。

## 与 browser-use 和 agent-browser 的比较

比较依据为 2026-11-15 查阅的官方文档与当前 ProfilePilot 源码。browser-use 的 Python Agent、CLI 和云服务应分别看待；不能用其中一种默认行为概括整个项目。

| 用户关心的事 | ProfilePilot | browser-use | agent-browser |
| --- | --- | --- | --- |
| 接入已有编程 Agent | CLI 与配套 Skill；可直接控制 | 有面向编程 Agent 的 CLI／Skill，另有 Python Agent 和云服务 | 面向 Agent 的浏览器 CLI，配套多种 Skill |
| 使用已登录的日常 Chrome | 普通网页通过已配对扩展连接 | 官方支持连接已打开 Chrome，CLI 也有这一路径 | 可用 CDP／auto-connect 连接现有 Chrome |
| 多 Agent 并行 | 不同 Profile／独立应用分开工作；同一 Profile 一个控制会话 | 支持每个 Agent 使用独立浏览器；共享同一个 Browser 对象并发有限制 | 独立 session；共享 CDP 浏览器还可用 `--pin-tab` 固定并锁定标签页 |
| 闲鱼、小红书等现成读取 | 9 站 21 项操作；闲鱼有筛选、对比和采样历史流程 | 可用通用能力与自定义工具构建；本次所查文档未确认同等内置目录 | 有通用提取、站点 Skill 和 API 客户端生成工具；未确认同等内置目录 |
| 跨应用和设备 | 浏览器、Electron、安卓使用同一 CLI 家族与管理界面 | 所查产品主线是浏览器自动化 | 已覆盖 Electron，并有 iOS Safari 路径；不能笼统写“只支持网页” |
| 过程可见与控制 | 桌面管理、扩展状态、任务归属、接管与交还 | 需按所选本地／云产品比较 | 已有本地 dashboard 展示浏览器与命令活动 |
| 更值得先试的场景 | 本机日常任务、中文站点读取、多个本地目标与安卓协作 | 自建浏览器 Agent 或使用其云端服务 | 以浏览器工具链为主、偏 CLI 的自动化和测试 |

官方依据：[Browser Use 浏览器与并发](https://docs.browser-use.com/open-source/browsers)、[Browser Use CLI](https://docs.browser-use.com/open-source/browser-use-cli)、[agent-browser Sessions](https://agent-browser.dev/sessions)、[CDP 与标签页锁定](https://agent-browser.dev/cdp-mode)、[Skills](https://agent-browser.dev/skills)、[Dashboard](https://agent-browser.dev/dashboard)。最后一行是基于这些能力的选型建议。

### 原稿需要替换的说法

| 原稿或容易使用的说法 | 修订口径 |
| --- | --- |
| 其他工具只能打开没登录的浏览器 | 两款竞品均可复用已有浏览器或登录态；介绍 ProfilePilot 自己的扩展连接流程 |
| browser-use 必须再运行一套模型循环 | 区分 Python Agent 和供外部 Agent 使用的 CLI |
| 多 Agent 并行是独有优势 | 重点解释不同目标的会话归属、占用提示和接管流程 |
| 有 Skill、CLI、可视化就是差异 | 竞品也有；展示具体任务少了哪些准备与脚本工作 |
| 数据都在本机 | Profile 和本地记录保存在本机；任务所需页面内容、截图可发送到用户选用的模型服务 |
| 扩展正在等待商店审核 | 截至用户最后说明，开发者账号尚待购买；取得真实提交状态后再改口径 |
| 比竞品更快、更省 token、更稳定 | 当前没有三方同条件结果，不写排名或总体提升百分比 |

已有站点实验能说明一些具体任务的表现，但并不是与这两款竞品的公平基准。[现有评测入口](agent-task-benchmarks.md) 也尚未提供两款竞品的现成适配器。

## 推广前最值得做的工作

| 优先级 | 当前问题或缺口 | 具体工作与完成标准 |
| --- | --- | --- |
| P0 | 下载版与本地开发能力有时间差 | 2026-11-15 查到 `latest` 桌面资产更新时间仍为 10 月 9 日，11 月 12 日发布流程失败。先修复发布链路，再用实际下载包复现全部演示。见 [Release](https://github.com/ffffhx/profilepilot/releases/tag/latest) 与 [失败运行](https://github.com/ffffhx/profilepilot/actions/runs/43203287346) |
| P0 | 首次上手仍引导配置模型、进入 Agent | README 第一次使用第 3–4 步与当前外部 Agent 主线不一致；CLI 顶层帮助也先介绍内置对话。待修改为“安装 → 连扩展 → 装 CLI／Skill → 外部 Agent 完成第一件事”。本轮仅提出修订内容，未修改 README |
| P0 | 扩展尚无已确认的商店发布 | 完成开发者注册、草稿 item、正式 ID／公钥核对、隐私页与截图、打包和提交。审核期保留如实说明的手动安装路径；完整材料见 [商店准备](native-extension-store.md) |
| P0 | 卖点缺少短而直接的证据 | 做三段独立实录：闲鱼筛选报告；不同 Profile 并行；用户接管后输入停止。用同一个可下载版本录制，并显示日期与版本 |
| P1 | 安装体验尚未从陌生用户角度验收 | Windows 和 macOS 各找新用户从下载开始走完；记录卡住的步骤、用时、人工介入次数及第一件任务是否成功，先以 5 分钟完成为设计目标，不宣传为已达成绩 |
| P1 | 网站能力不易发现 | 在连接完成后给出“站点能力”与三个可复制任务示例；区分通用网页操作和专用适配，显示读取范围、原链接和当前结果状态 |
| P1 | “让 Agent 自己安装”缺少清晰入口 | 提供安装提示，优先检测现有 CLI、目标与占用，再说明实际缺少步骤。Claude Code 本来可以使用 Skill／CLI；没有插件 marketplace 不等于无法接入 |
| P1 | 缺少可信的比较素材 | 固定工具／模型版本与同等登录条件，分别比较通用网页任务、站点适配任务和多目标协作；保留失败、人工干预、任务终态、总用时与模型用量，勿把工具返回成功当任务成功 |
| P2 | 仓库介绍与反馈路径还可完善 | 发布前核对仓库描述、Topics、官网入口、英文上手说明和演示封面；提供含系统、版本、目标类型的反馈模板。不以增加功能数量替代首次成功率 |

### 上手提示草稿

> 请使用 ProfilePilot 帮我处理网页任务。先读取 ProfilePilot Skill，检查 `ppilot` 是否已安装、我的默认 Profile 是否已连接以及是否被其他会话占用。已有连接就继续使用；缺少步骤时按当前官方安装说明给出最少操作。第一件任务只读取我指定页面并总结内容，结束后释放会话。

这段提示用于减少用户手动查命令的负担；它不表示目前已有一条可在全新机器上无人值守安装所有组件的命令。

### Windows 与 macOS 的验收差异

桌面应用提供两平台安装入口，但当前网站适配性能材料主要来自 Windows，不能当作 macOS 实测。两边都要检查中文／空格路径、CLI 的 PATH、扩展持久安装、Chrome 重启和升级后的配对保留。Windows 检查 PowerShell 参数与中文编码、安卓驱动；macOS 检查安装提示与真实设备连接。当前原生桌面控制仅支持 Windows，并继续留在高级功能中。iPhone 需要签名 WebDriverAgent 与开发者模式，不与安卓一起宣传为即装即用。

## V2EX 推广文章

以下发布稿以新下载版完成上述验收为前提。标题：**做了个给 Claude Code／Codex 用的本地工具，内置闲鱼、小红书读取，还能操作安卓**

大家好，分享一个自己在做的开源项目 **ProfilePilot**。

它让 Claude Code、Codex 等 Agent 通过一个 CLI，操作我已经登录的 Chrome、本地 Electron 应用和安卓手机。

browser-use、agent-browser 已经能完成很多浏览器任务，复用登录态和多会话也都有相应方案。我做 ProfilePilot，主要是想把自己每天反复用到的几件事直接准备好。

**第一是网站任务。** 现在有闲鱼、小红书、BOSS、B站等 9 个站点的结构化读取。比如在闲鱼找内存，可以按预算和规格筛候选，继续核对详情，生成带原链接的对比报告；信息缺失的会标成待确认。之后重复采样，还能比较挂牌价格变化。小红书则可以读取搜索结果、笔记和已加载评论。

**第二是多个任务的目标管理。** 不同 Agent 可以使用不同 Profile／应用，各自处理自己的任务。一个查资料，一个验收本地项目；同一个 Profile 被占用时会提示，不会直接抢走。遇到需要人工处理的步骤，可以暂停接管，交还后再继续。

**第三是跨应用。** 浏览器、Electron、安卓分别使用 `ppilot browser`、`ppilot electron`、`ppilot phone`，一起提供配套 Skill 和连接检查。我希望 Agent 既能检查刚改的网页，也能接着验证安卓 App。

日常 Chrome 通过扩展连接，沿用当前 Profile 的登录态。普通网页任务可以在后台进行，桌面管理窗口也不必一直开着。控制命令本身不额外调用模型，继续使用你自己的 Agent。

这是个早期项目，MIT 开源，桌面端有 Windows／macOS。扩展当前需要按引导手动加载，商店状态会在项目说明中更新。Profile 和本地记录保存在电脑上；交给 Agent 的页面内容仍可能发送到你使用的模型服务。

如果你已经有顺手的浏览器工具，可以先试一次闲鱼筛选或跨设备任务，看看这些现成流程对你有没有用。

项目：[github.com/ffffhx/profilepilot](https://github.com/ffffhx/profilepilot)

欢迎反馈你最想让 Agent 处理的具体任务，以及安装或第一次使用卡在哪里。

**随帖素材：** 一张实际商品对比报告、一段不同 Profile 并行与接管实录、一张上手步骤图。发帖当天根据真实商店状态更新安装说明。

## X 推文

### 英文推文串

1. I built ProfilePilot for the work I keep giving my coding agent: research signed-in websites, compare listings, and test local apps. One CLI connects Chrome, Electron and Android. MIT open source.

2. The useful part: built-in reads for 9 sites, including Xianyu and Xiaohongshu. Xianyu can filter listings, check details and produce a comparison report with source links and fields that still need checking.

3. Multiple agents can work on different Profiles or apps. Each target has an owner; a second agent cannot silently take over an occupied Profile. You can pause and take control when a task needs you.

4. browser-use and agent-browser already support real-browser workflows and multiple sessions. Try ProfilePilot if you want its site-specific reads, local target management and Android workflow in one place.

5. Use your existing coding agent. ProfilePilot's control commands don't run a second model loop. Your local records stay on your machine; page content you give the agent may go to your model provider.

6. Early access: the Chrome extension currently requires manual loading. I'd love feedback on one real task, from setup to the final result. Code and installation: https://github.com/ffffhx/profilepilot

首条配实录，展示任务结果；第 6 条的安装状态以发布当天为准。

### 中文单条

做了个开源工具 ProfilePilot，给 Claude Code／Codex 用。

内置闲鱼、小红书等网站读取，闲鱼可筛商品、核对详情、生成对比报告。不同 Agent 能在不同 Profile／应用里并行工作，目标被占用就提示，也能人工接管。

一个 CLI 连接 Chrome、Electron、安卓。想找经常让 Agent 处理这些任务的人试用：
https://github.com/ffffhx/profilepilot

## 小红书图文

标题：**我让 AI 帮我筛闲鱼商品**

封面主文案：**给条件，拿到候选和待确认项**

图片顺序：

1. 真实任务条件与最终报告同屏。
2. 候选商品的价格、规格、原链接。
3. 一条被排除的商品，以及对应的原文理由。
4. 一条信息不全的商品，显示“待确认”。
5. 两个不同 Profile 的任务同时运行，标清各自目标。
6. 暂停／接管，以及安装入口。

正文：

最近给自己的 AI 加了个工具：ProfilePilot。

我会把想买的规格、预算和排除条件告诉它，让它在已经登录的闲鱼里找候选、核对详情，再整理成一份对比报告。

我最想要的是把“符合”“不符合”和“还得问卖家”分清楚。比如标价对应单条还是套装，容量有没有写全，卖家有没有说明维修情况。工具能整理页面信息，实物情况还是要继续核实。

它还做了小红书等网站的读取，可以交给 Claude Code、Codex 使用。不同任务能放在不同 Profile／应用里运行，也能随时暂停接手。

项目 MIT 开源，名字叫 ProfilePilot。现在还是早期版本，扩展需要手动加载。想了解使用步骤或反馈具体任务，可以看看项目说明。

标签：#AI工具 #ClaudeCode #Codex #开源项目 #独立开发 #效率工具

## 视频脚本

### 60 秒版

标题：**为什么我还做了一个浏览器 Agent 工具**

| 时间 | 实录画面 | 口播 |
| --- | --- | --- |
| 0–6 秒 | 闲鱼对比报告：候选、价格、原链接、待确认项 | “这是 AI 帮我整理的闲鱼候选。规格不全的地方，它会列出来让我核对。” |
| 6–14 秒 | 终端输入条件，网页读取，报告逐项出现 | “我做了 ProfilePilot，给闲鱼、小红书等网站准备了专门的读取和整理能力。” |
| 14–24 秒 | 两个 Agent，两个明确标记的 Profile | “一个 Agent 查资料，另一个验收项目。不同 Profile 各自运行，同一个目标被占用就提示。” |
| 24–34 秒 | 用户点击接管，Agent 停止；交还后重新观察 | “需要我处理时，我就接过来。交还之后，它再继续。” |
| 34–43 秒 | 浏览器、Electron、安卓各一段短实录 | “同一套 CLI，也能连接 Electron 应用和安卓手机。” |
| 43–53 秒 | 简洁文字：网站适配、目标管理、安卓 | “browser-use 和 agent-browser 也支持登录态和多会话。我更想解决的是这些本地日常任务的准备工作。” |
| 53–60 秒 | 项目名、仓库链接、实际安装提示 | “如果你也常做这些任务，可以试试 ProfilePilot，告诉我哪一步还不够顺手。” |

### 3 分钟版

| 时间 | 内容 | 必须展示的证据 |
| --- | --- | --- |
| 0:00–0:20 | 任务和最终结果 | 给出规格与预算，展示真实报告及原链接 |
| 0:20–0:45 | 工具是什么，适合谁 | 只介绍外部 Agent、CLI、扩展与三个主要目标类型 |
| 0:45–1:20 | 专用网站流程 | 搜索、详情核对、待确认项；保留真实失败或阻塞的处理 |
| 1:20–1:50 | 多目标并行 | 两个不同 Profile 的任务标识，同时运行；结束一个后另一个继续 |
| 1:50–2:10 | 人工接管 | 接管后输入停止，交还后读取新状态 |
| 2:10–2:30 | Electron／安卓 | 各展示一项实际完成的验收步骤，不用浏览器设备模拟冒充手机 |
| 2:30–2:50 | 和两款工具怎么选 | 展示比较表中的使用场景，不放未经测量的速度和成功率排名 |
| 2:50–3:00 | 试用入口 | 当天可用下载包、扩展安装方式与反馈入口 |

录制使用演示账号与真实下载版。加速片段明确标倍率，显示版本和录制日期。浏览器展示可单独录制任务页；“后台运行”需要同时拍到用户工作窗口保持不变。以上为可录制脚本，尚未生成成片。

## 发布节奏

先完成下载版、上手路径和三段实录，再邀请 5–10 位目标用户试装。收集“能否安装、首次任务是否成功、哪里需要人帮忙”，据此调整文案和产品。

首发建议选一个开发者社区集中答疑；修复主要卡点后再发 X，随后把一个具体任务改成小红书图文与短视频。渠道之间留出处理反馈的时间，不设未经验证的最佳发帖时段或流量承诺。

首轮观察四件事：下载后完成连接的人数、首次任务成功人数、一周后再次使用人数、重复出现的问题。Star 可以参考，但不足以判断工具是否被持续使用。

## 本轮核对记录

- 本地基线：`3caf3f1`；已有其他工作区改动，本轮仅新增方案与原稿存档。
- 已读取官方竞品文档、当前站点目录、扩展与 Gateway 控制代码、相关测试、安装指引、两平台边界及 GitHub 发布状态。
- 已通过安装的 CLI 核对 9 站 21 项操作，并以已有默认 Profile 打开原文链接；页面要求登录，原文未改动，浏览器任务已结束。
- 未在本轮运行三方性能基准、真实站点全集验收或全新机器安装；文案没有把这些写成已通过。
- 未修改 README、产品代码、发布配置；未发送帖子、购买账号、提交商店审核或触发发布。
