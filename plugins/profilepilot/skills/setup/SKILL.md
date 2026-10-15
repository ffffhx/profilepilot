---
name: setup
description: "Set up the ProfilePilot plugin on Windows or macOS, diagnose a missing ppilot CLI, and check the user's selected browser or Android connection after installation."
---

# Set up ProfilePilot

Prepare the user's requested ProfilePilot route and report the evidence of readiness. Installing this plugin installs instructions; it does not install ProfilePilot, Chrome's extension, device drivers, or the Android companion. Use the current host's local shell. A web-only execution environment cannot reach the user's local devices.

## Check the installation

1. Detect Windows or macOS and locate `ppilot` (`Get-Command ppilot -All` in PowerShell; `command -v ppilot` on macOS). If installed, run `ppilot --version` and `ppilot --help`. For app-dependent routes, `ppilot status --json` checks the desktop connection.
2. If missing, direct the user to [ProfilePilot releases](https://github.com/ffffhx/profilepilot/releases/latest). Select Windows x64, macOS Apple Silicon, or macOS Intel from the actual computer architecture. The downloaded desktop app is a separate prerequisite. Do not run an installer or change operating-system trust settings merely because this plugin was installed. Follow the user's existing authorization for installation.
3. In ProfilePilot, use **配套工具 → 安装 ProfilePilot CLI** (Install ProfilePilot CLI). This installs the CLI, its browser driver, and the desktop-managed Agent instructions. Open a fresh terminal if PATH was updated, then check the command again. The app and plugin may both expose a ProfilePilot skill; that is not a reason to delete user-managed skills or preferences.
4. If a required subcommand is missing, inspect `ppilot browser --help` or `ppilot phone --help`, then update the desktop app and refresh its CLI. Do not assume that two builds with the same displayed application version expose the same commands.

Windows and macOS installers currently may be unsigned. Explain an actual operating-system prompt and let the user decide; do not silently remove quarantine, disable security protections, or request administrator privileges for routine CLI use. Windows Android USB connections may need a device manufacturer's driver; macOS screen capture may need Screen Recording permission.

## Connect only the requested route

Read [ProfilePilot](../profilepilot/SKILL.md), including any existing target preferences, before connection or interaction.

- **Existing Chrome tabs:** Run `ppilot browser status`. This may start the independent local browser service. In the desktop app's **配套工具**, install/connect the ProfilePilot extension in the exact Chrome profile the user selected. Use actual IDs from status and `tabs`; do not copy browser data or select a different logged-in profile. Keep any pairing secret out of the chat. A compatible connected extension and available ownership are required before claiming a task session.
- **Managed browser or Electron app:** Confirm `ppilot status --json`, then use `ppilot browser --connection gateway profiles` and the [Gateway reference](../profilepilot/references/agent-browser.md). Use the registered logical port, not a native debug port. Register an Electron app through ProfilePilot if needed.
- **Android:** Run `ppilot phone --help` and `ppilot phone list`. Read the [Android reference](../profilepilot/references/phone.md) before pairing, installing the companion, or starting control. Let the user approve USB debugging, pairing, and Android permissions on the device. A disconnected USB record may coexist with a working Wi-Fi connection. Do not start an emulator or switch devices unless the user chose that target.

Setup does not require configuring another model service: direct browser/phone CLI operations use the current host agent. `ppilot run`, chat, and optional separate CAPTCHA inference have additional model requirements and are not installation checks.

## Verify readiness

Report the located CLI and the selected route's actual connection/ownership status. If the user requested a demonstration, claim a new task session, make an authorized observation, and complete it using the selected route's lifecycle. Do not claim a paused or occupied target to prove setup works. If input or sign-in is needed, state the exact missing step and wait for the user. Do not claim that an untested platform or unavailable device is ready.
