# ProfilePilot 推广方案 Claude 原稿存档

原文：[ProfilePilot 推广方案：发布前体检与推广文案](https://claude.ai/artifact/ED7tdyEE9Zm3Pisg8Ly8Ee)。Claude 于 2026-11-15 写入；本副本从同一会话的文档写入记录恢复。末次读取确认文档为 rev 9。云端现状未能读取：当前浏览器显示需要登录。

这是未经修订的历史原稿，包含已发现的竞品描述、并行范围、扩展审核状态及数据流向问题。请使用 [修订方案](promotion-plan.md)；存档保留原文供核对，不作为当前产品宣传依据。用户最后提出的对比与卖点修改尚未写入此原稿。图形组件未复制，排期图位置已作标记。

---

## 结论速览

现在还不适合大规模推广：新用户按 README 或下载链接走，会遇到旧安装包、找不到 Agent Tab、要开 Chrome 开发者模式这三道坎。建议先用约一周修完下面 5 件事，再按第 8 节的节奏发帖。

1. **先发一版能用的安装包。** 线上桌面安装包停在 2026-10-09；11-12 那次 main 发布因 Windows 构建失败没有发出去。推广时别人下载到的版本和你演示的不一致。
2. **README 和官网改成以“外部 Agent + CLI”为主线。** 现在首屏截图、第一次使用的第 3–4 步、`ppilot --help` 第一行都在讲内置 Agent，但 Agent 已默认关闭、放进高级。新用户照着做会卡住。
3. **降低扩展安装门槛。** 扩展未上架 Chrome Web Store，新用户要开开发者模式、加载未打包扩展。尽快提交商店审核；审核期间配一段 20 秒的安装 GIF。
4. **做一个“让 Agent 自己装”的入口。** CLI 目前只能在 App 的「配套工具」里点安装。给出一段可以直接贴给 Claude Code / Codex 的安装提示，并补上 Claude Code 插件清单。
5. **补齐门面。** GitHub 仓库描述、Topics、主页链接都是空的，也没有自定义社交预览图；在 X 和 V2EX 贴链接时只会显示默认卡片。再加一个 30–60 秒的演示 GIF 放到 README 首屏。

现状数据（2026-11-15 查询）：213 Star、18 Fork；`latest` 桌面安装包下载量为个位数（Windows exe 5 次、macOS dmg 各 2 次）。

## 发布前体检

内容已经够用，卡点在“新用户前 5 分钟”。下表按优先级排列：P0 不修会直接流失推广带来的用户，P1 影响转化率，P2 可以边推广边补。

| 优先级 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| P0 | 线上安装包过旧 | release.yml 11-12 的 main 发布中 `Build Windows x64` 失败，macOS 被取消；`latest` 的 exe/dmg 停在 2026-10-09 | 修好 Windows 构建，重发一版；用干净虚拟机从下载开始走一遍 |
| P0 | README 与产品现状不一致 | 首屏截图是 Agent Tab，“第一次使用”要求配模型后回到 Agent；“五个 Tab”表仍把 Agent 列第一；发布流程写着“推送 main 不会自动构建”，而 release.yml 实际在 main push 时触发 | 改写为“装 App → 连扩展 → 装 CLI → 让你的 Agent 试一句话”四步；内置 Agent、桌面、GPUI 移到“高级功能”小节 |
| P0 | 扩展未上架商店 | docs/native-extension-store.md 状态为“发布材料准备中”；首次要开开发者模式、加载未打包扩展 | 立刻提交 Chrome Web Store 审核；审核期在连接页旁放一段安装 GIF，并在帖子里提前说明 |
| P0 | 外部 Agent 接入只有一条路 | CLI 只能在 App「配套工具」安装；仓库有 Codex 插件市场，没有 `.claude-plugin`；不提供 MCP Server | 加一个“把这段话贴给你的 Agent”安装提示；补 Claude Code 插件清单；评估一个薄 MCP 封装以覆盖 Cursor / Claude Desktop 用户 |
| P1 | 仓库门面为空 | `gh repo view`：description、topics、homepage 均为空，未设自定义 Social Preview | 补一句英文描述、官网链接，Topics 加 `ai-agent`、`browser-automation`、`claude-code`、`codex`、`android`、`chrome-extension`；做一张 1280×640 预览图 |
| P1 | 没有动态演示 | README 只有两张静态截图，截图来自 10-08，已过时 | 录一段 30–60 秒 GIF：终端里 Claude Code 一句话 → 日常 Chrome 后台完成任务；放在首屏 |
| P1 | 没有英文 README | X 受众以英文为主，当前 README 只有一行英文 | 补 README.en.md，只翻“是什么、为什么、怎么装、对比”四段即可 |
| P1 | 未签名安装包 | README 已写 macOS 需 `xattr` 解除隔离；Windows 会触发 SmartScreen | 推广前至少配截图说明“更多信息 → 仍要运行”；Windows 可申请 SignPath 的开源免费签名（需自行确认条件） |
| P1 | 界面和帮助里的内部术语 | 截图里出现“Jev · 未配置”；CLI 帮助和文档大量使用 Gateway、CDP、逻辑端口 | 普通用户可见处换成结果导向的说法；`ppilot --help` 第一屏先列 browser / phone，对话命令放后 |
| P1 | 缺竞品对比 | README 未说明和 browser-use、Playwright MCP 有何不同 | 加一张对比表（见下方），诚实写出不适合的场景 |
| P2 | 首次体验未计时 | 本次没有在干净数据目录里实测 | 用隔离数据目录跑一遍，记录从下载到第一条 `ppilot browser` 命令成功的耗时，目标 ≤ 5 分钟 |
| P2 | 反馈渠道单一 | 只有 Issues | 开 GitHub Discussions，加 Issue 模板（系统、版本、`ppilot doctor --json` 输出）；可选建一个微信/TG 群 |
| P2 | 版本号信号弱 | package.json 与 CLI 都是 0.1.0，桌面版走滚动 `latest` | 推广时发一个带号的 `v0.x` Release 和更新说明，帖子里引用它 |

### 你提到的几点

- **高级功能收起来：** 方向对。代码里 Agent、GPUI、桌面已经默认关闭，但文档、官网、CLI 帮助还没跟上，要一起改。
- **README 详细程度：** 不缺信息，缺顺序。前一屏只需回答“它是什么、开头 3 分钟怎么用、和别的有什么不同”，发布流程、数据目录、构建细节移到 docs。
- **UI 易懂度：** 新手引导已经有，但引导内容要跟新主线一致：第一站应该是「配套工具」连扩展和装 CLI，而不是 Agent。
- **skill / CLI 是否够用：** 这是项目最强的部分。`profilepilot` skill 覆盖目标选择、后台不抢焦点、用户接管；CLI 有 `schema`、`doctor`、动作后自动返回观察。短板是“装上它”这一步，而不是能力。

### 和同类项目比

下表是按公开资料的大致对比（凭记忆整理，发帖前请对照各项目最新 README 核对）。ProfilePilot 最清楚的差异是：直接用你已登录的日常 Chrome，一个 CLI 同时管浏览器、Electron 和安卓，并且不绑定任何模型。

| 项目 | 形态 | 用日常已登录 Chrome | 手机 / 桌面应用 | 自带模型循环 |
| --- | --- | --- | --- | --- |
| ProfilePilot | 桌面 App + CLI + skill + Chrome 扩展 | 是，扩展直连，不重启、不复制 Profile | Android、iPhone、Electron；Windows 桌面为高级功能 | 不需要；由 Claude Code、Codex 等外部 Agent 驱动 |
| browser-use | Python 库 / 云服务 | 主要启动独立浏览器 | 不覆盖 | 是，自己调用 LLM |
| Playwright MCP | MCP Server | 默认独立浏览器，有扩展桥接模式 | 不覆盖 | 否 |
| Chrome DevTools MCP | MCP Server | 需调试端口或独立实例 | 不覆盖 | 否 |
| Claude in Chrome 等官方扩展 | 浏览器扩展 | 是 | 不覆盖 | 绑定各自模型 |
| Midscene.js | JS SDK | 可通过扩展 | Android | 是，视觉模型驱动 |

推广时也要诚实写不适合的场景：大规模云端爬取、需要指纹伪装的场景、macOS 桌面控制。主动说清楚比被评论区指出更有信任感。

## 定位与卖点

一句话：**给 Claude Code / Codex 一双手，直接用你已登录的 Chrome 和安卓手机干活，后台运行、不抢鼠标，随时接管。**

英文版：*Give Claude Code and Codex hands: your signed-in Chrome and Android phone, in the background, with you in control.*

**目标用户（按优先级）**

1. 每天用 Claude Code、Codex、Cursor 等本地 Agent 的开发者，想让 Agent 处理需要登录的网页任务。
2. 做前端、Electron、安卓开发，希望 Agent 自己跑验收的人。
3. 需要管理多个 Chrome Profile 的人（多账号、测试环境）。

**三个核心卖点（所有文案围绕它们）**

1. **不用重新登录。** 扩展直连你平时用的 Chrome，不重启浏览器、不开调试端口、不复制 Profile，沿用已有登录和标签页。
2. **一个命令管三类设备。** `ppilot browser`、`ppilot electron`、`ppilot phone` 共用一套会话和接管机制，配套 skill 告诉 Agent 怎么选目标、怎么不打扰你。
3. **你始终在场。** Agent 在后台操作，不切你的窗口和标签页；你可以随时暂停、接管，交还前 Agent 不会继续输入。

**打消顾虑的一句话：** 开源 MIT，数据默认留在本机；控制命令本身不调用任何模型，用什么模型由你的 Agent 决定。

**不要在推广里强调的：** 内置 Agent、Windows 桌面控制、GPUI、远程电脑。评论区有人问再提“高级里可以打开”。

## X（Twitter）

主贴用英文推文串，第 1 条必须带 30–45 秒演示视频；中文单条用于中文圈转发。每条已控制在 280 字符内，链接放在最后一条，避免首条被限流。

### 英文推文串（6 条）

**1/**
I got tired of AI agents opening a fresh, logged-out browser every time.

So I built ProfilePilot: Claude Code and Codex can now use the Chrome I'm already signed into — and my Android phone — in the background, while I keep working.

Open source. 🧵
[配视频：终端一句话 → 日常 Chrome 后台完成任务]

**2/**
How it works:
• A Chrome extension connects your everyday profile. No relaunch, no debug port, no copied profile.
• One CLI, `ppilot`, for browser, Electron apps and Android.
• A bundled skill tells your agent which target to use and how not to get in your way.

**3/**
It doesn't steal your screen.

The agent works by tab/window ID, so your active tab, focus and mouse stay yours. Hit pause or take over anytime — the agent won't type again until you hand it back.

**4/**
No model lock-in. `ppilot` commands never call an LLM themselves. Any agent that can run a shell command can drive it: Claude Code, Codex, Cursor, your own scripts.

Every action returns a fresh page snapshot, so agents spend fewer turns just looking.

**5/**
Android too: connect over USB or Wi‑Fi, and the agent can tap, type and read the screen through the same session model.

Useful for testing your own app, or for the chores that only exist on your phone.

**6/**
Free, MIT, local-first. macOS + Windows desktop, Android 11+.

⭐ github.com/ffffhx/profilepilot

Early days — I'd love to hear what you'd have your agent do with your real browser.

### 中文单条

做了个开源工具 ProfilePilot：让 Claude Code / Codex 直接用你已经登录的 Chrome 和安卓手机干活。

不用重新登录、不抢你的鼠标和标签页，随时暂停接管。一个 `ppilot` 命令管浏览器、Electron 和手机，任何能跑命令行的 Agent 都能用。

MIT 开源 👇
github.com/ffffhx/profilepilot

**发布小贴士**

- 在第 1 条里 @ 一两个你真实交流过的 Claude Code / Codex 圈子博主，不要群发 @。
- 发帖后 1 小时内尽量回复每条评论，这段时间对推荐权重影响最大。
- 3–4 天后再发一条只讲安卓的短视频推文，引用原推文串。

## V2EX（分享创造节点）

V2EX 读者对营销腔很敏感，帖子要像开发者讲自己解决了什么问题，并主动说清楼限制。发在「分享创造」，配 2–3 张图或一个 GIF。

**标题：** 写了个开源工具，让 Claude Code / Codex 直接用你已登录的 Chrome 和安卓手机干活

**正文：**

大家好，分享一个自己用了几个月的工具：**ProfilePilot**。

GitHub：https://github.com/ffffhx/profilepilot（MIT）

**起因**

平时用 Claude Code / Codex 写代码，经常想让它顺手做点浏览器里的事：查一下后台数据、填个表单、验收一下刚改的页面。但大部分浏览器自动化工具都会开一个全新的、没登录的浏览器，要么就要求你带调试端口重启 Chrome。还有一个问题是它们干活时会抢窗口，我就没法同时做别的。

**它做了什么**

- **用日常 Chrome：** 装一个扩展，连上你平时的 Profile。不重启、不开调试端口、不复制 Profile，已有登录都能用。
- **一个 CLI：** `ppilot browser` / `ppilot electron` / `ppilot phone`，浏览器、本地 Electron 应用、安卓手机共用一套会话和接管机制。
- **配套 skill：** 装 CLI 时一起装，告诉 Agent 怎么选目标、怎么在后台工作。Claude Code、Codex 或任何能跑命令的 Agent 都能用。
- **不抢前台：** 按标签页 / 窗口 ID 操作，不切换你当前的标签页。你可以随时暂停、接管，交还前 Agent 不会再输入。
- **省轮次：** 每个点击、输入之后自动返回新的页面快照，Agent 不用每步再“看一眼”。
- **顺带：** Chrome 多 Profile 管理、账号同步与备份。

**和 browser-use / Playwright MCP 有什么不同**

browser-use 更偏“自带 LLM 循环的自动化库”，Playwright MCP 是给 Agent 的浏览器工具。ProfilePilot 不自带模型，重点在“用你自己的环境”和“人和 Agent 共用一台电脑”，且一套命令覆盖浏览器之外的 Electron 和安卓。

**上手**

1. 下载桌面版（macOS / Windows）：https://github.com/ffffhx/profilepilot/releases/latest
2. 「配套工具」→ 选你的 Chrome Profile → 安装并连接扩展
3. 同一页安装 ProfilePilot CLI，新开终端
4. 对你的 Agent 说：“用 ppilot 打开我的 GitHub 通知页，帮我按仓库汇总未读”

**已知限制（先说清楚）**

- 扩展还在等 Chrome 商店审核，目前要开开发者模式加载，App 里有引导
- 安装包还没做代码签名，macOS / Windows 首次打开会有提示
- 安卓需要 11+，没有 iOS App
- 不做指纹伪装 / 反检测，不适合大规模爬取

**数据**

Profile、任务记录、配置都在本机。`ppilot` 控制命令本身不调用任何模型，页面内容只会发给你自己的 Agent 所用的模型。

还在早期，欢迎踩坑和提建议。最想知道：你会让 Agent 用你的真实浏览器做什么？

**发帖提醒**

- 要等上面 P0 的安装包发布好再发；V2EX 帖子很难二次曝光。
- 工作日上午 10–11 点发，发后追评论，对批评不辩护，直接开 Issue 并回复链接。
- 若扩展已上架，把“已知限制”第一条改成商店链接。

## 小红书

小红书读者更看场景和画面，少讲技术名词。用图文笔记（6–7 张图），标题 20 字内。正文不放外链，写“GitHub 搜 profilepilot”，避免被判定引流。

**标题备选（任选一）**

- 让 AI 用我登录好的浏览器干活，终于不用重新登录了
- 给 Claude Code 装上手：它自己开网页、点手机
- 程序员的偷懒神器｜AI 后台帮我点网页

**封面文案（大字）：** AI 终于能用我的浏览器了
副标题：不用重新登录 · 不抢鼠标 · 开源免费

**图片顺序**

1. 封面：左边终端输入一句话，右边 Chrome 里已登录的页面在变化
2. 痛点：“其他工具——开一个空白浏览器 / 要你重新登录 / 抢你的窗口”
3. 场景一：让它把网页上的商品价格整理成表格
4. 场景二：改完代码，让它自己打开页面验收并截图
5. 场景三：连上安卓手机，让它帮你点一遍 App 流程
6. 安全感：暂停 / 接管按钮特写 + “数据都在本机”
7. 上手 4 步截图

**正文**

用 AI 写代码久了，最烦的一件事：想让它顺手在网页上干点活，它就开一个全新的空白浏览器，什么都没登录 😮‍💨

所以我自己写了一个开源小工具 **ProfilePilot** 👇

✨ 直接用你平时的 Chrome，登录状态都在，不用重新登录
✨ AI 在后台操作，不抢你的鼠标和标签页，你该干嘛干嘛
✨ 随时按暂停 / 接管，你不交还它就不动
✨ 还能连安卓手机，让 AI 帮你点 App
✨ Claude Code、Codex 都能用，不绑定模型

我自己常用的几个场景：
📌 把几个网页的信息汇总成表格
📌 改完前端代码，让它自己打开页面检查一遍
📌 测试自己做的安卓 App

🔒 开源免费（MIT），数据都在自己电脑上。支持 Mac / Windows，安卓 11 以上。

想试试的去 GitHub 搜「profilepilot」，有问题评论区问我～

**标签**

#AI工具 #ClaudeCode #Codex #程序员 #效率工具 #开源项目 #浏览器插件 #AIAgent #独立开发 #自动化

**提醒：** 小红书对“自动化点击 / 批量操作账号”类内容较敏感，示例场景避开营销号、刷量、批量发帖。

## 短视频脚本

两版共用一套素材：60 秒版发抖音 / 视频号 / X，3 分钟版发 B 站和 YouTube，并作为 README 首屏视频的来源。竖屏 9:16 用上下分屏（上终端、下浏览器），横屏 16:9 用左右分屏。

**录制前准备**

- 用已发布的新安装包录，确保观众下载后看到的界面一致
- 准备一个演示用 Chrome Profile，提前登录好 GitHub 等公开可展示的站点，避免录入私人账号信息
- 终端字号调到 18pt 以上，竖屏下也要看清
- 加速片段在画面角落标“2x”，不要偷偷加速

### 60 秒版（抖音 / 视频号）

| 时间 | 画面 | 口播 / 字幕 |
| --- | --- | --- |
| 0–3s | 终端里打字，下方 Chrome 页面自己在动 | “我的 AI 刚刚自己用了我的浏览器，而我一下都没碰。” |
| 3–10s | 快切：别的工具弹出空白浏览器、登录页 | “以前让 AI 开网页，它会开个空白浏览器，什么都没登录。” |
| 10–25s | Claude Code 输入：“打开我的 GitHub 通知，按仓库汇总未读”；下方 Chrome 后台打开新标签页、滚动；终端输出汇总表 | “现在它直接用我已经登录的 Chrome。注意看，我当前的标签页一直没变。” |
| 25–35s | 实时点「暂停 / 接管」，终端显示等待交还 | “想自己接手？按一下。你不交还，它就不动。” |
| 35–48s | 画中画：安卓手机屏幕，Agent 点开设置、输入搜索 | “安卓手机也一样，USB 或 Wi‑Fi 连上就行。” |
| 48–56s | 三行字卡：`ppilot browser` / `ppilot electron` / `ppilot phone` | “一个命令管浏览器、桌面应用和手机，Claude Code、Codex 都能用。” |
| 56–60s | 结尾卡：ProfilePilot 图标 + “GitHub 搜 profilepilot” | “开源免费，去 GitHub 搜 ProfilePilot。” |

**标题：** 让 AI 用我登录好的浏览器干活，我照样摸鱼
**置顶评论：** 项目开源在 GitHub：profilepilot，支持 Mac / Windows / 安卓。有问题评论区问。

### 3 分钟版（B 站 / YouTube）

| 时间 | 章节 | 画面 | 要点 |
| --- | --- | --- | --- |
| 0:00–0:15 | 开场 | 同 60 秒版 0–25s | 先给结果，再讲过程 |
| 0:15–0:40 | 为什么做 | browser-use / Playwright 开独立浏览器的画面 | 重新登录、开调试端口、抢窗口三个痛点 |
| 0:40–1:20 | 上手 | 下载 → 「配套工具」连扩展 → 装 CLI → 新开终端 `ppilot browser status` | 如实录开发者模式加载扩展一步，说明商店版在审核 |
| 1:20–1:55 | 浏览器演示 | 一个真实任务：汇总未读通知或验收你刚改的网页 | 强调当前标签页不变、动作后自动返回页面快照 |
| 1:55–2:15 | 接管 | 任务中途接管，手动填一个验证码，再交还 | 人和 Agent 共用一台电脑 |
| 2:15–2:40 | 安卓 + Electron | 手机画中画；再切到一个 Electron 应用 | 同一套会话和接管规则 |
| 2:40–2:55 | 和别的工具比 | 对比表字卡 | 诚实说不适合的场景 |
| 2:55–3:00 | 结尾 | GitHub 地址 + Star 按钮 | 问观众：你会让 Agent 做什么？ |

演示任务建议选“开发者一看就懂、且不暴露隐私”的：GitHub 通知汇总、验收本地页面、安卓设置里切一个开关。

## 发布节奏

先在中文开发者社区收反馈、修问题，再去英文社区；渠道之间隔 1–2 天，留出回复评论和修 bug 的时间。

[原稿此处为交互排期图：11月16–22日准备，23–25日试装，26日 V2EX，27日 X，29日小红书，12月1日抖音／视频号，3日 B站，8日 Show HN／Reddit。仅为原稿建议日期。]

日期是建议值，前提是 P0 已修完、试装没有卡点；Show HN / Reddit 等英文 README 和商店版扩展就绪后再发。其他可补的渠道：掘金、即刻、LINUX DO、awesome-claude-code 类列表。

**发帖当天清单**

- [ ] 安装包、README、官网、演示视频是同一版本
- [ ] GitHub 仓库描述、Topics、社交预览图已设置
- [ ] 备好 3 个常见问题的回复：安全性、和 browser-use 的区别、为什么要开发者模式
- [ ] 发帖后 2 小时内守着评论区
- [ ] 记录每个渠道带来的 Star 和下载量（GitHub Insights → Traffic）
