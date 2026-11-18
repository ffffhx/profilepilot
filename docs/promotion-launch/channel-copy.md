# 发布文案

准备日期：2026-11-15。以下是可复制的正文；未代发。正式招募前，先用更新后的下载包完成首次任务。现有下载资产仍停留在 10 月 9 日，本文描述当前源码能力。扩展商店状态按发帖当天更新。

## V2EX

标题：做了个给 Claude Code / Codex 用的工具，读取闲鱼、小红书，也能连接安卓

大家好，分享一个自己在做的 MIT 开源项目 **ProfilePilot**。

它给 Claude Code、Codex 等已有 Agent 提供一套本地 CLI：连接已登录的 Chrome、本地 Electron 应用和安卓手机。

browser-use、agent-browser 已经很好用了，也有复用登录态和多会话的办法。我做这个项目，主要想把自己反复用到的任务准备得更直接一些。

比如找闲鱼商品。告诉 Agent 规格、预算、排除条件，再让它搜索候选、核对详情，整理标题、挂牌价、原链接，以及还需要确认的信息。之后再次采样，可以比较自己的采样记录；它不能凭空补出过去一年的价格。

当前源码内置 9 个站点、21 项读取操作，包括闲鱼、小红书、B站、BOSS 等。各站能力不同：小红书评论只包括实际加载的部分，YouTube 字幕需要视频本身已有字幕。无结果、读取失败和只读到部分内容也要区分。

另一个重点是目标管理。不同 Agent 可以分别使用不同 Profile 或独立应用。一个查资料，一个检查本地项目；同一 Profile 被占用时会提示，不能直接抢走。需要我登录或处理页面时，可以接管，之后再交还。

浏览器、Electron 和安卓分别走 `ppilot browser`、`ppilot electron`、`ppilot phone`，配套提供 Skill。日常 Chrome 通过扩展连接；外部浏览器控制不需要桌面管理窗口一直打开，也不会额外启动一套模型循环。

这还是早期项目。桌面端有 Windows / macOS，扩展目前按引导手动加载，商店进度以项目说明为准。本地 Profile 和记录在电脑上，但交给 Agent 的页面内容、截图可能发送到你选用的模型服务。

如果你已经有顺手的工具，可以先试一次站点读取或网页加安卓的任务，看看这些现成流程是否有帮助。我尤其想了解：第一次安装卡在哪里，以及最后结果有没有真的完成你的任务。

项目：https://github.com/ffffhx/profilepilot

欢迎贴一个可公开的任务描述。反馈请附系统、App / CLI / 扩展版本和出错步骤，不要附配对码、Cookie 或私人页面。

## X 英文串

每段单独发布，顺序回复上一条。配图用 social-cover.png 或 first-task.png；不依赖视频。链接按 23 字符、其他字符按 X 加权规则保守核验，报告见 validation.json。

<!-- tweet:en-1 -->
I built ProfilePilot for my existing coding agent: read signed-in websites, compare listings, and check local apps. One CLI connects Chrome, Electron and Android. MIT open source.
<!-- /tweet -->

<!-- tweet:en-2 -->
The current source includes structured reads for 9 sites, including Xianyu and Xiaohongshu. Read listings and details, keep source links, and flag missing information. These experimental adapters have different limits.
<!-- /tweet -->

<!-- tweet:en-3 -->
Different agents can use different Profiles or independent apps. An occupied Profile has an owner; a second agent cannot silently take it over. Pause for a manual step, then hand control back.
<!-- /tweet -->

<!-- tweet:en-4 -->
browser-use and agent-browser already support real-browser workflows and multiple sessions. ProfilePilot is worth trying for its ready-made site reads, local target management and Android workflow together.
<!-- /tweet -->

<!-- tweet:en-5 -->
Keep your coding agent. ProfilePilot's control commands do not run a second model loop. Local records stay on your machine; page content and screenshots you give the agent may go to its model provider.
<!-- /tweet -->

<!-- tweet:en-6 -->
Early project; the Chrome extension currently needs manual loading. I'd love feedback on one real task, from setup to the final result. Check the release notes before installing. Code: https://github.com/ffffhx/profilepilot
<!-- /tweet -->

## X 中文单条

<!-- tweet:zh -->
做了个给 Claude Code / Codex 用的开源工具 ProfilePilot。内置闲鱼、小红书等网站读取；不同 Agent 可在不同 Profile / 应用里工作。一个 CLI 连接 Chrome、Electron、安卓。想找人试一次真实任务：
https://github.com/ffffhx/profilepilot
<!-- /tweet -->

## 小红书

标题：给现有 AI 接上闲鱼和安卓

正文：

平时已经在用 Claude Code / Codex，我想让它们再帮我处理一些网页和手机上的事，于是做了 ProfilePilot。

拿闲鱼找内存举例：先说清规格和预算，让 Agent 搜索候选、核对详情，再把“描述符合”“不符合”“信息不足”分开，保留挂牌价和原链接。单条还是套装、是否维修过，没有证据就继续标成待确认，不能当成已经验证的商品。

它也有小红书等站点的读取能力。不同 Agent 可以放在不同 Profile / 独立应用里工作，互相不接管对方的目标；需要我操作时可以暂停接手。

图片是一份使用流程图解，示意字段不代表真实商品或实测成绩。当前是早期项目，网站读取仍在实验阶段；扩展按引导手动加载。项目 MIT 开源，在 GitHub 搜索 ffffhx/profilepilot 可以看到安装说明和进度。

我更想知道：你最想交给 Agent 的一个具体任务是什么？

#AI工具 #ClaudeCode #Codex #开源项目 #效率工具

图片顺序：01 接入已有 Agent → 02 写清筛选条件 → 03 结果保留证据 → 04 分开管理目标 → 05 接管与交还 → 06 首次上手。六张均为 1080×1440 图解，不伪装运行实录。

## 常见回复

**为什么不用 browser-use / agent-browser？**

都可以，也不用为了 Star 数换工具。ProfilePilot 更想解决的是现成中文站点读取、本地目标管理和安卓协作。多会话、登录态、CLI 本身都不是独有功能；建议用你自己的任务试一次。

**更快或更省 token 吗？**

还没有三方同条件的数据，所以目前不做排名。比较协议已准备，会同时记录失败、人工介入和实际模型用量。

**能在同一个 Profile 的多个标签页同时跑吗？**

这里说的并行是不同 Profile / 独立应用。同一受控 Profile 保持一个控制会话；多个 Agent 不能同时操作同一部手机或共享桌面鼠标。

**会上传账号吗？**

Profile 与本地记录在本机。Agent 为完成任务读取的网页内容、截图和结果可能发送给你使用的模型服务。请查看扩展隐私说明并按任务范围授权，不能把“本地工具”理解为“所有数据永不离机”。

**不配置模型能用吗？**

使用已有外部 Agent 时，控制命令本身不再启动模型循环。内置 Agent 是另外一条可选路径，首次上手不要求使用它。

**商店里能装了吗？**

目前未确认 Chrome Web Store 上线状态，先按当前安装说明手动加载。只有后台实际发布后，才替换成真实商店链接。
