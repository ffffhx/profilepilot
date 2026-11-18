# 仓库与英文入口

以下为准备好的设置值，未修改远程仓库设置。

## Description

Local CLI for coding agents: signed-in Chrome, Electron and Android, with structured site reads and per-target control sessions.

## Website

https://ffffhx.github.io/profilepilot/

新版首页和中英文上手页已在本地完成，官网需单独手动部署。部署后英文入口为 https://ffffhx.github.io/profilepilot/site/start.html#english 。

## Topics

agent-tools, browser-automation, chrome-extension, electron, android, cli, local-first, typescript, codex, claude-code

## 英文简介

ProfilePilot connects your existing coding agent to signed-in Chrome, local Electron apps and Android devices. It provides a CLI, bundled agent instructions, experimental site-specific reads, and control sessions tied to explicit targets. Different agents may work on different Profiles or independent apps. Page content given to an agent may be sent to its model provider.

## README 上手段落替换稿

按项目要求，尚未修改 README.md。下面内容可在明确允许修改 README 后替换首次使用的引导；无需重新编写。

1. 从 GitHub Releases 下载对应系统和芯片架构的桌面版本，查看该版本说明。
2. 在“配套工具”连接你的 Chrome Profile。尚无商店链接时，按应用显示的固定目录加载扩展并配对。
3. 从同一入口安装 ProfilePilot CLI 和配套 Skill，重新打开终端，运行 `ppilot --version` 与 `ppilot browser status`。
4. 在你已有的 Claude Code / Codex 中发送：请读取 ProfilePilot Skill，检查默认 Profile、连接和占用，只读我指定的页面，整理三条要点及原链接，完成后结束会话。

当前新版路径已落实在官网与 `site/start.html`。CLI 顶层内置对话帮助没有在这次推广材料任务中调整；可直接使用清楚标注的 `ppilot browser` 命令。
