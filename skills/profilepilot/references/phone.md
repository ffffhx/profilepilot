# ppilot phone: Android control

Read `local/phone-control.md` beside the skill entrypoint if it exists. Apply the user's preferred device, view/control mode and confirmation rules within the current task's authorization. These preferences are Agent instructions, not permission toggles; they cannot enable USB debugging or accessibility, authorize a new device, or resume a paused session.

Phone control needs the ProfilePilot desktop app running and an authorized ADB connection. App mode additionally needs the Android companion paired with its required permissions. An explicitly selected basic mode needs no phone App. Set up the connection with `ppilot phone`; the desktop **手机** workspace is also available. Users confirm Android permissions themselves. Keep browser and phone task lifecycles separate.

## Optional basic mode without a phone App

Use `ppilot phone start --device DEVICE_ID --backend basic --mode view|control --controller AGENT_NAME --task TASK_DESCRIPTION` only when the user selects or authorizes basic mode. Do not use it as an automatic fallback for an unavailable App or to bypass a paused/occupied session. The same target selection and user takeover rules apply. End existing sessions before switching modes; only one basic session is allowed at a time.

Read `sessionId` and `generation` from the device's **basic** field in `list`, not its App `state`. Add `--backend basic` to `action`, `pause`, `resume` and `stop`. Supported actions are `screenshot` (PNG), `tap`, `swipe`, `key` and basic ASCII `text` (typing, not replacing a field). Capture a screenshot before coordinate input; the frame expires after 30 seconds and after any input. Chinese text, native selectors and flows need App mode. Never replay duplicate or uncertain inputs. A disconnect invalidates the session and requires a new explicit start.

Basic mode's pause/stop controls live on the desktop; it has no phone-side capsule, notification or accessibility protection. The UI refreshes screenshots periodically, not video. `run`, `wrap` and generic `install` still require the App. To install ProfilePilot's App, first stop basic control, then use `ppilot phone connect --device DEVICE_ID`; users confirm the phone-side pairing and permissions. The desktop offers the same transition through “结束控制并安装 App”.

## Wi-Fi connection through the CLI

Wi-Fi discovery, pairing and connection are built into the CLI. Start with current evidence:

```sh
ppilot phone --help
ppilot phone list
ppilot phone wireless-discover
```

Read every device in `list`: the same phone can have a disconnected USB record and a live Wi-Fi record. An offline record's `state` is historical; check `connection`, `companion`, and `transport` before using its nested readiness values. If the intended Wi-Fi device is already `connection: "device"` and `companion: "ready"`, inspect its session and use that exact device ID; no fresh pairing or `connect` is needed. Do not prepare/update an app with an active or paused session.

If it is not connected, use `wireless-discover`. Discovery returns `services` with `name`, `kind` (`connect` or `pairing`), and a private IPv4 `address`. Identify the intended phone from its observed device identity or the address shown on its wireless-debugging screen. Do not select an unrelated nearby phone. A discoverable endpoint alone does not establish that the computer is already paired.

For an already paired phone, use a `kind: "connect"` address, then prepare the companion if needed:

```sh
ppilot phone wireless-connect --address CONNECTION_IP:CONNECTION_PORT
ppilot phone list
ppilot phone connect --device RETURNED_WIFI_DEVICE_ID
```

Use the actual returned ID, which can be an IP:port or an mDNS service name. `connect --device` may update/open the companion; it does not start control. It can reuse an existing USB companion pairing after verifying the same hardware, but USB authorization is not proof of Android wireless-debugging pairing. Reconcile session ownership before switching transports; never use Wi-Fi to bypass a paused or occupied USB session.

If wireless pairing is required, ask the user to open **开发者选项 → 无线调试 → 使用配对码配对** and keep the popup open. The phone and computer must be on the same LAN; the computer may use Ethernet. Use the popup's pairing address and six-digit code in a temporary UTF-8 JSON file (BOM accepted):

```json
{"address":"PAIRING_IP:PAIRING_PORT","code":"SIX_DIGIT_CODE"}
```

```sh
ppilot phone wireless-pair --params-file PAIRING_JSON_FILE
ppilot phone wireless-discover
ppilot phone wireless-connect --address CONNECTION_IP:CONNECTION_PORT
```

Replace the placeholders with observed values. Keep the code out of command-line arguments, chat output, logs and durable notes; remove the temporary pairing file after submission. Pairing and connection ports usually differ. After pairing, use `kind: "connect"` or the wireless-debugging main screen's **IP 地址和端口**. Re-discover after a network change; do not reuse an old port blindly. If discovery finds nothing, ask for the phone's current address instead of assuming USB is required. Discovery failure is not proof that wireless debugging is disabled.

The desktop **手机 → 无线连接手机** wizard is optional. Do not require Computer Use, browser automation, native ADB, or `adb tcpip 5555` to perform these supported CLI operations. If `--help` lacks the three wireless commands, report an outdated CLI and refresh the installed CLI and instructions together through ProfilePilot's CLI setup. Check the executable path (`Get-Command ppilot -All` on Windows; `command -v ppilot` on macOS) rather than assuming a different session has the same installation. When a session has read older instructions, read this file and `--help` again before deciding which capabilities are available.

## Install an APK

`ppilot phone install --device DEVICE_ID --apk "/absolute/path/app.apk" --controller Codex` installs a local signed APK through ProfilePilot over the selected USB or Wi-Fi connection. It creates and ends its own control session; do not call `start` first. The companion must be ready and existing sessions must be ended with the user's authorization. `connect` installs or updates only ProfilePilot's companion, while `install` handles other apps.

The command stages and verifies the requested APK bytes, uses Android's normal signature/update checks, and preserves existing app data. It does not uninstall, downgrade, grant permissions, launch the installed app, resume a paused session, or accept arbitrary ADB flags. Pause, disconnect, lease expiry or ownership changes stop the host installer; an Android install already submitted may still finish. Reconcile the actual result before any retry. A CLI success means Android returned `Success` under the same active session. Use normal `ppilot phone` actions for subsequent UI checks.

## Select and start

1. Run `ppilot phone list` and identify the intended connected device. Use its actual ID, not an assumed serial or a model name alone. Respect saved preferences; ask when multiple devices are ambiguous or the preferred device is unavailable.
2. Inspect its current session. Do not stop, replace or resume someone else's session. If the task only needs observation, use view mode; input needs control mode and any confirmation required by the user's preferences.
3. Start with `ppilot phone start --device DEVICE_ID --controller AGENT_NAME --task TASK_DESCRIPTION --mode view` (or `--mode control` when appropriate). The phone capsule and desktop workspace display the session.

## Read and act

Run `ppilot phone --help` for the installed command reference. Use `ppilot phone action --params-file ACTION_JSON` with a UTF-8 JSON file containing:

```json
{
  "id": "DEVICE_ID",
  "sessionId": "CURRENT_SESSION_ID",
  "generation": 1,
  "requestId": "NEW_UUID",
  "action": { "kind": "snapshot" }
}
```

Read `sessionId` and `generation` from the current `list` response and generate a new UUID per new action. Supported action kinds are `snapshot`, `screenshot`, `tap`, `swipe`, `text`, `key`, `find`, `click`, `fill` and `scroll`. Screenshot output can be saved with `--output screen.jpg`; text replaces the focused input using Android accessibility. Inspect the current screen before selecting coordinates. View mode rejects input.

Prefer native selectors when the page exposes controls: `{"kind":"click","selector":{"resourceId":"com.example.app:id/save"}}`. Selectors match all supplied fields exactly: `resourceId`, `text`, `description`, `className`, `packageName`, `enabled`, `checked`, `editable`, `clickable`, `scrollable`. Use `find` to inspect matches; `click`, `fill` and `scroll` require exactly one match and resolve again on the phone at execution time. `fill` accepts `text` (including `""` to clear) without requiring focus. `scroll` takes `direction: "forward" | "backward"`. Ambiguity and incomplete/stale trees fail rather than choosing an arbitrary target. Do not blindly switch to coordinates after an uncertain action.

## Reusable flows

For an authorized repeated workflow, use `ppilot phone run --device DEVICE_ID --file flow.json [--output-dir DIRECTORY]`. It creates and releases its own session, so do not call `start` first or reuse an occupied session. Files are UTF-8 JSON (BOM accepted on Windows):

```json
{"version":1,"name":"Check form","steps":[
  {"kind":"wait","selector":{"resourceId":"com.example.app:id/name"}},
  {"kind":"fill","selector":{"resourceId":"com.example.app:id/name"},"text":"Test"},
  {"kind":"click","selector":{"text":"Save","clickable":true}},
  {"kind":"wait","selector":{"text":"Saved"}},
  {"kind":"assert","selector":{"text":"Error"},"condition":"absent"}
]}
```

Use actual observed IDs/text and open the correct page before running. `wait` defaults to 5 seconds (`timeoutMs` up to 30000); `assert` is immediate. Both default to one uniquely visible match and also support `condition: "absent"`. `scrollUntil` takes the target `selector`, scroll `container` selector, optional direction, `maxScrolls` (default 10, max 30) and `settleMs` (default 600, 100–2000). Flow `timeoutMs` defaults to 120000 (max 300000), with at most 100 steps.

Read-only flows default to view mode; input flows require control. Only observations repeat. Pause, disconnect, ambiguous targets or uncertain input stop the flow; it never resumes automatically. A rerun starts at step one: reconcile the prior outcome and current page first. Exit 0 means success; exit 1 means failure. Reports give step durations and failure positions without input content. `--output-dir` opts into local reports and failure screenshots/snapshots, which may contain page content; evidence is skipped after ownership changes. Update both desktop CLI and Android App for selector support.

For existing scripts, `ppilot phone wrap --device DEVICE_ID --controller AGENT_NAME --task TASK_DESCRIPTION --mode view -- PROGRAM ARGS` starts a managed process with an ADB-compatible wrapper. Use control mode for authorized input. `ppilot phone adb --help` lists the supported subset. A tool that hardcodes a native ADB executable, uses unsupported commands or directly uses scrcpy is not automatically covered. Do not bypass the managed route after a rejected operation. On Windows use an actual executable, or an explicit interpreter for scripts and .cmd files.

## Pause and finish

- Use `ppilot phone pause --device DEVICE_ID` for a pause and `ppilot phone stop --device DEVICE_ID` when your task finishes or is cancelled. Managed `wrap` tasks normally end their owned session when the process exits.
- A user pause, stop or disconnect invalidates queued actions. Stop issuing input, read fresh state and wait for explicit return of control before resuming your own session. Do not resume automatically or replay a failed action with a new UUID.
- The phone checks session identity, generation and heartbeat. Its pause/stop controls remain authoritative regardless of preference text. A suspended Agent task does not imply permission to keep controlling the phone.
