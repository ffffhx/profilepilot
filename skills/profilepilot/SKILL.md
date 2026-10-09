---
name: profilepilot
description: "Control the user's browser or Android phone with ProfilePilot CLI. Use ppilot browser for signed-in Chrome tabs, managed Chrome/Electron and Profile management; use ppilot phone for Android viewing, input and managed ADB tools. Follow personal control preferences and user takeover."
---

# ProfilePilot CLI — Agent 使用指引

Guide the Agent to the user's intended browser or Android phone and preserve its identity and control ownership. Browser control uses `ppilot browser`; Android control uses `ppilot phone`. This skill supplies personal preference routing, connection and lifecycle rules.

Naming: **ProfilePilot CLI** is the user-facing installation, including the `ppilot` executable and these bundled **Agent instructions** (skill ID `profilepilot`). Its browser command group is `ppilot browser`; phone commands use `ppilot phone`. Install and update the CLI and instructions together from the app's single CLI entry. The agent-browser driver and its Wrapper are internal to the unified CLI, not additional installation steps. Existing `agent-browser` commands remain compatible when their legacy launcher is installed.

The extension route uses an independent browser service, automatically started by `ppilot browser`; the desktop App is optional for external Agent browser control. Profile management, built-in AI tasks and other desktop features still use the App. Each route needs only its selected CLI, extension or host integration.

## Choose the route first

Before connecting, read the personal preferences for the selected target if present beside this file: `local/browser-routing.md` for browsers, `local/electron-control.md` for Electron apps, `local/phone-control.md` for phones. These are edited in the app's **控制偏好 → 浏览器 / Electron / 手机** tabs. For Electron, if its dedicated preference file is absent, consult any Electron-specific instructions in the older `local/browser-routing.md`. Absence is normal and does not prevent use. They guide target selection, connection or control mode and action confirmations; they do not grant permissions or override user takeover. Follow current user instructions and applicable AGENTS.md first.

For Android work, read [ppilot phone: Android control](references/phone.md) and use the actual device ID from `ppilot phone list`. Apply any saved device and mode preferences; if no preferred device is connected or the target is ambiguous, ask instead of silently switching phones. Continue with the browser routing below only for browser work.

Wi-Fi discovery, pairing and connection are available through `ppilot phone wireless-discover`, `wireless-pair` and `wireless-connect`. Check `ppilot phone --help` for the installed commands; the desktop wireless wizard is optional. A disconnected USB record does not rule out an online Wi-Fi route for the same phone. Use the phone reference to discover and identify that route before requesting USB reconnection or opening a desktop-control tool.

Prefer the ProfilePilot extension and `ppilot browser` for the everyday default Chrome Profile. Use ChatGPT `@Chrome` only when the user explicitly selects that integration; it is not a prerequisite or automatic fallback.

Confirm the target from actual Profile IDs, extension connections or Gateway bindings. A managed Profile named “系统默认 Profile-1”, or a directory named `Default`, does not establish that it is the user's everyday Chrome Profile. Select one route and load only its reference:

| Task / selected route | Read |
| --- | --- |
| List, inspect, create, rename, start, stop or delete Profiles | [ProfilePilot CLI: Profile management](references/profiles.md) |
| Control the actual default Profile or another connected Profile using the ProfilePilot extension | [ProfilePilot Browser CLI](references/browser-extension.md) |
| Control a managed Profile or registered Electron app with ppilot browser | [ppilot browser: Gateway connection](references/agent-browser.md) |
| Use Playwright CLI with a managed Profile | [Playwright CLI through Gateway](references/playwright-cli.md) |
| Configure/use Chrome DevTools MCP with a managed Profile | [DevTools MCP through Gateway](references/chrome-devtools-mcp.md) |
| User explicitly selects ChatGPT `@Chrome` | [ChatGPT Chrome integration](references/chatgpt-chrome.md) |

For the default Profile, the ProfilePilot extension controls its existing pages without copying the Profile. This route is independent of the Agent's model or host: Codex, Claude Code and other local Agents with CLI access can use the same `ppilot browser` commands. For other managed browser work, use the user's configured driver. If the selected route is unavailable, report the missing prerequisite; do not silently switch accounts or transport or require the user to move to ChatGPT.

## Shared control rules

- Use one task session per target and one active controlling route. Never use another tool, Profile, session or direct CDP connection to bypass user takeover, an occupied Profile or a Gateway stop.
- A user handoff preserves the session while the user acts. Resume only after explicit return of control. Observe the page again; old element references are invalid.
- Complete a session when its work is finished; release it when the task is cancelled. Do not complete while waiting for a required user action. Use the selected route's lifecycle commands, never commands from another route.
- After a timeout/disconnect, inspect state before proceeding. Do not replay an action whose outcome is unknown. Exit code 75 requires reconciliation, not automatic retry.
- Prefer background reads and interactions. Do not activate/relaunch a browser or Electron window just to inspect it. A wrapper cannot suppress an application's own startup focus or native dialogs.
- Check the actual OS and installed tools. Use discovered IDs/ports and portable `--params-file` JSON input; do not copy fixed macOS paths, shell syntax or personal port tables to Windows.

## Installation and personal policy

The app's “Install ProfilePilot CLI” entry installs the executable and these instructions for shared Agents, Codex and Claude. Existing CLI installations receive matching instructions on refresh. Updates check all bundled references and preserve `local/`; removal archives managed instructions and retains personal preferences. External skills and links remain externally maintained; a version mismatch is reported in setup details. The browser driver ships with ProfilePilot on Windows and macOS; no global agent-browser install is needed. Other tool compatibility is optional. Personal preferences stay in `local/browser-routing.md`, `local/electron-control.md` and `local/phone-control.md`; keep credentials and transient session IDs out of these files. Backups reside under `~/.profilepilot/skill-backups/`.
