---
name: profilepilot
description: "Control browsers, Electron apps, the local Windows desktop, Android phones, or remote computers with ProfilePilot CLI. Use ppilot browser for Chrome and Profile management, ppilot electron for local Electron apps, ppilot desktop for Windows windows and native dialogs, ppilot phone for Android, and ppilot remote for ClipRelay-connected computers. Follow personal control preferences and user takeover."
---

# ProfilePilot CLI — Agent 使用指引

Guide the Agent to the user's intended browser, Electron app, local Windows window or Android phone and preserve its identity and control ownership. Browser control uses `ppilot browser`, Profile management uses `ppilot browser profile`, Electron control uses `ppilot electron`, native Windows control uses `ppilot desktop`, and Android control uses `ppilot phone`. The older `ppilot profile` and Electron `ppilot browser --cdp` spellings remain compatible. This skill supplies personal preference routing, connection and lifecycle rules.

Naming: **ProfilePilot CLI** is the user-facing installation, including the `ppilot` executable and these bundled **Agent instructions** (skill ID `profilepilot`). Its browser command group is `ppilot browser`; phone commands use `ppilot phone`. Install and update the CLI and instructions together from the app's single CLI entry. The TypeScript browser engine and its guarded Wrapper ship inside ProfilePilot; no agent-browser Rust executable is needed. Existing `agent-browser` command names remain compatibility entrypoints when their legacy launcher is installed.

The extension route uses an independent browser service, automatically started by `ppilot browser`; the desktop App is optional for external Agent browser control. Profile management, built-in AI tasks and other desktop features still use the App. Each route needs only its selected CLI, extension or host integration.

## Choose the route first

Use the installed command contract when a capability or parameter is unclear: `ppilot <route> schema <command>` or `ppilot <route> <command> --help` gives a narrow answer without starting control. For connection preparation, use `ppilot doctor --route electron|desktop|gpui --session TASK` (or select the actual target with `--electron`, `--window`, `--gpui`, `--profile` or `--device`). Read the returned route, available operations, ownership state and exact next command. A missing registration is a preparation step, not evidence that the target cannot be controlled. A task with a sufficient dedicated Skill/API, such as proxy-rule configuration, should use that semantic interface before a UI route.

For instrumented GPUI native applications, read [ppilot gpui: GPUI debugging](references/gpui.md). Use `ppilot gpui` and the app's **GPUI 应用** page; GPUI does not expose CDP. Discover the actual target instance, preserve its session, and respect user takeover. Uninstrumented GPUI apps require an application-side bridge before semantic debugging works.

Desktop interaction is a fallback: use it only when the user explicitly requests desktop control, or after verifying that the other applicable CLI, API, browser, and Electron routes cannot complete the required operation. Before switching, state which routes were checked and the specific limitation; a failed attempt alone is not sufficient.

For this computer's native Windows desktop or system dialogs, read [ppilot desktop: local Windows control](references/desktop.md) and use `ppilot desktop`. ProfilePilot supplies its own native driver and control UI; ClipRelay is not required. Browser pages and Electron page content keep their dedicated routes. The native desktop driver currently supports Windows, not macOS.

For another computer, read [ppilot remote: computer control](references/remote.md) and use `ppilot remote`. Select the exact discovered device before reading its Profiles or windows. The local `ppilot browser` and `ppilot profile` commands target this computer; they are not substitutes for a remote target. ClipRelay's installed application supplies the connection background service; MCP setup is optional.

Before connecting, read the personal preferences for the selected target if present beside this file: `local/browser-routing.md` for browsers, `local/electron-control.md` for Electron apps, `local/phone-control.md` for phones. These are edited in the app's **控制偏好 → 浏览器 / Electron / 手机** tabs. If a personal file is absent, read the same file name under `templates/` beside this file; those shipped defaults cover background operation, user takeover and confirmation timing only. A personal file always takes precedence over its template. For Electron, if its dedicated personal file is absent, consult any Electron-specific instructions in the older `local/browser-routing.md` before falling back to `templates/electron-control.md`. Absence of both is normal and does not prevent use. They guide target selection, connection or control mode and action confirmations; they do not grant permissions or override user takeover. Follow current user instructions and applicable AGENTS.md first.

For Android work, read [ppilot phone: Android control](references/phone.md) and use the actual device ID from `ppilot phone list`. Apply any saved device and mode preferences; if no preferred device is connected or the target is ambiguous, ask instead of silently switching phones. Continue with the browser routing below only for browser work.

For iPhone real devices, read [ppilot phone: iPhone control](references/iphone.md). Use `ppilot phone iphone` for Windows/macOS preparation, signing guidance and USB connection, then the same phone session/action commands. iPhone requires a signed WebDriverAgent and Developer Mode; Android ADB, companion and takeover features do not apply.

Wi-Fi discovery, pairing and connection are available through `ppilot phone wireless-discover`, `wireless-pair` and `wireless-connect`. Check `ppilot phone --help` for the installed commands; the desktop wireless wizard is optional. A disconnected USB record does not rule out an online Wi-Fi route for the same phone. Use the phone reference to discover and identify that route before requesting USB reconnection or opening a desktop-control tool.

Prefer the ProfilePilot extension and `ppilot browser` for the everyday default Chrome Profile. Use ChatGPT `@Chrome` only when the user explicitly selects that integration; it is not a prerequisite or automatic fallback.

Confirm the target from actual Profile IDs, extension connections or Gateway bindings. A managed Profile named “系统默认 Profile-1”, or a directory named `Default`, does not establish that it is the user's everyday Chrome Profile. Select one route and load only its reference:

| Task / selected route | Read |
| --- | --- |
| List, inspect, create, rename, start, stop or delete Profiles | [ProfilePilot CLI: Profile management](references/profiles.md) |
| Control the actual default Profile or another connected Profile using the ProfilePilot extension | [ProfilePilot Browser CLI](references/browser-extension.md) |
| Control a managed Profile with ppilot browser or a registered Electron app with ppilot electron | [Gateway connection and Electron apps](references/agent-browser.md) |
| User explicitly selects ChatGPT `@Chrome` | [ChatGPT Chrome integration](references/chatgpt-chrome.md) |

For the default Profile, the ProfilePilot extension controls its existing pages without copying the Profile. This route is independent of the Agent's model or host: Codex, Claude Code and other local Agents with CLI access can use the same `ppilot browser` commands. For other managed browser work, use the user's configured driver. If the selected route is unavailable, report the missing prerequisite; do not silently switch accounts or transport or require the user to move to ChatGPT.

## Shared control rules

For visible CAPTCHA puzzles during an authorized browser task, prefer the Agent in the **current conversation**: inspect the page and screenshot, reason about the answer, act through the same browser session, then verify the page result. Read [CAPTCHA in the current conversation](references/captcha.md) when this occurs. Do not start another Codex process or buy a solver task merely because a CAPTCHA appeared. Those are explicit alternatives when the current Agent cannot solve it or the user selects them.

- Use one task session per target and one active controlling route. Never use another tool, Profile, session or direct CDP connection to bypass user takeover, an occupied Profile or a Gateway stop.
- A user handoff preserves the session while the user acts. Explicit consent in the current conversation to return control authorizes resuming the same target and session through its supported command. Do not ask for the same permission again or require an app click solely as a skill rule.
- Authorization does not prove that the controller has resumed. Check the command result; if it still requires a hand-back action, explain that concrete prerequisite and keep target actions paused. Do not change sessions, routes, persisted control state or controller checks to bypass the requirement. After a successful resume, observe again; old element references are invalid.
- Complete a session when its work is finished; release it when the task is cancelled. Do not complete while waiting for a required user action. Use the selected route's lifecycle commands, never commands from another route.
- After a timeout/disconnect, inspect state before proceeding. Do not replay an action whose outcome is unknown. Exit code 75 requires reconciliation, not automatic retry.
- Read structured recovery before deciding whether to ask the user: validation/precondition failures can be `not-executed`, while a sent operation with no conclusive response remains `unknown`. Technical frame recovery preserves the existing owner; user takeover still requires explicit return. For usage diagnosis, see [CLI diagnostics and task traces](references/cli-diagnostics.md).
- Prefer background reads and interactions. Do not activate/relaunch a browser or Electron window just to inspect it. A wrapper cannot suppress an application's own startup focus or native dialogs.
- Check the actual OS and installed tools. Use discovered IDs/ports and portable `--params-file` JSON input; do not copy fixed macOS paths, shell syntax or personal port tables to Windows.

## Installation and personal policy

The app's “Install ProfilePilot CLI” entry installs the executable and these instructions for shared Agents, Codex and Claude. Existing CLI installations receive matching instructions on refresh. Updates check all bundled references and preserve `local/`; removal archives managed instructions and retains personal preferences. External skills and links remain externally maintained; a version mismatch is reported in setup details. The browser driver ships with ProfilePilot on Windows and macOS; no global agent-browser install is needed. Other tool compatibility is optional. Personal preferences stay in `local/browser-routing.md`, `local/electron-control.md` and `local/phone-control.md`; keep credentials and transient session IDs out of these files. The shipped `templates/` files hold the generic defaults, are replaced on update, and never overwrite a personal file. Backups reside under `~/.profilepilot/skill-backups/`.
