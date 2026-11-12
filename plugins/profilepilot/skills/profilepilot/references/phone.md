# ppilot phone: Android control

For iPhone real devices, use [the iPhone reference](iphone.md). The Android instructions below do not apply to iOS.

Read `ppilot phone default` when the user has not specified a device. The phone page stores this default, including a stable device identity where available. Confirm `available` and use its current `deviceId`; `--device default` resolves that same saved target for ordinary CLI commands and fails when it is unavailable. Explicit `--device ID` always wins. A task authorization determines view/control mode; the default setting grants no permissions and cannot resume a paused session. Keep the target and session fixed during the task.

Phone control needs the ProfilePilot desktop app running and either an authorized ADB connection or an explicitly paired Internet control connection. App mode additionally needs the Android companion connected with its required permissions. `ppilot phone connect` automatically pairs the companion over the system-authorized debugging connection; there is no extra App confirmation. Users confirm Android USB/wireless debugging authorization; accessibility setup can use the explicitly authorized recovery command below. An explicitly selected basic mode needs no phone App. Set up the connection with `ppilot phone`; the desktop **手机** workspace is also available. Keep browser and phone task lifecycles separate.

## Internet control from a cloud computer

For a phone already paired through **外网控制**, select its actual `internet-…` ID from `ppilot phone list`. This is a native HTTPS control transport, separate from status synchronization. It needs neither a local PC nor Tailscale, USB or a shared Wi-Fi network.

On the cloud computer, use `ppilot phone internet configure --params-file config.json` with `{"enabled":true,"port":18770,"advertisedUrl":"https://YOUR_PUBLIC_HOST:18770"}`. The endpoint must be reachable through both host and cloud firewalls. Use `internet status` to inspect the listener, paired phones and transfer progress. Create a three-minute pairing invitation with `internet pair --output NEW_PRIVATE_FILE`; present it through the phone's **外网控制** pairing screen with the user's authorization. It pins the computer's certificate. Do not print the private invitation in logs or retain the temporary file after pairing. `internet forget --device ID` revokes that phone's pairing.

Use the same readiness, start, action, pause and stop commands. Supported native operations include screenshots, selectors, Unicode input, waking the screen, app version inspection, app launch and APK installation. `phone install` creates its own session and uses Android's ordinary package installer. If Android requires confirmation, it ends control and returns `installed: false`, `awaitingUserConfirmation: true` and a `jobId`; ask the user to confirm on the phone, then query `phone internet install-status --device ID --job JOB_ID`. A pending confirmation is not installation success. Some devices suppress overlay permissions on the system installer: do not switch routes or resume control to bypass that protection. Do not repeat the upload while the job is pending. After confirmation, inspect the actual installed version and start a fresh session for app checks.

The Internet route does not expose ADB shell, basic mode, PIN/pattern unlock, package export, logcat or virtual camera/video commands. An unlocked phone and its granted accessibility/overlay permissions are required. Update the companion through its own updater or an explicitly authorized existing ADB route. A network reconnect does not resume control or replay uncertain input; inspect the returned ownership and actual outcome first.

## Authorized accessibility recovery

Query a specific command with `ppilot phone schema action` or `ppilot phone exec --help`. JSON commands accept one of `--params-file` and `--params-stdin` (UTF-8, BOM accepted). Parameter errors return exit 2 with `not-executed`; connection/readiness failures describe their actual prerequisite, while ownership conflicts or uncertain outcomes return 75. Read the structured recovery before deciding the next step; do not infer an execution outcome from exit code alone. See [CLI diagnostics](cli-diagnostics.md) for Windows quoting and task-labelled trace reports.

If the user has authorized enabling ProfilePilot's accessibility service (including a saved, device-specific preference), use `ppilot phone accessibility-repair --device ACTUAL_DEVICE_ID`. It works through the paired companion without an accessibility-dependent control session. If necessary, it grants the companion `WRITE_SECURE_SETTINGS` through the authorized ADB connection; the companion preserves other enabled services and enables its own component plus Android's master accessibility switch. This also supports devices where the ordinary shell cannot write secure settings. Do not run it without permission to enable this service, or use it to bypass an occupied or paused session.

When the user also authorizes automatic recovery, add `--auto-restore on`. This saves an opt-in on the phone: while automatic recovery is enabled, App/service restarts or a disabled accessibility setting trigger a bounded restoration. `--auto-restore off` repairs the current state but disables subsequent automatic enabling; omitting the flag leaves the saved choice unchanged. The phone's **自动恢复 → 自动开启无障碍** setting also disables it. No control session starts/resumes. Reconcile `running` and `phone readiness` after the command; `enabled` alone is not proof of a running service. On timeout/disconnect inspect state before retrying. Old companions must be updated first; failure does not authorize switching to basic mode or another tool.

## Android emulator preview

Use `ppilot phone emulator-list`, then `ppilot phone emulator-connect --name ACTUAL_AVD_NAME` to start or reopen the selected emulator. The desktop **启动 / 连接模拟器** action uses the same path. On Windows it checks the window against the monitor's work area and adjusts an off-screen position or oversized window, including when reusing an already running emulator. A correction failure is reported instead of claiming the preview is ready. Existing minimized windows are left minimized.

Do not launch `emulator.exe` directly or through a custom shell/CIM process that bypasses this check. If a window is outside the screen, run the same `emulator-connect` command again; it reuses the AVD without reinstalling its App, restarting the emulator, or starting/resuming control. If the installed CLI lacks these commands, update the desktop CLI and instructions together first. Verify that the window and title bar are inside the desktop before handing over a preview. Phone setup and interaction still use the returned device ID and the session rules below.

## Optional basic mode without a phone App

Use `ppilot phone start --device DEVICE_ID --backend basic --mode view|control --controller AGENT_NAME --task TASK_DESCRIPTION` only when the user selects or authorizes basic mode. Do not use it as an automatic fallback for an unavailable App or to bypass a paused/occupied session. The same target selection and user takeover rules apply. End existing sessions before switching modes; only one basic session is allowed at a time.

Read `sessionId` and `generation` from the device's **basic** field in `list`, not its App `state`. Add `--backend basic` to `action`, `pause`, `resume` and `stop`. Supported actions are `screenshot` (PNG), `tap`, `swipe`, `key` and basic ASCII `text` (typing, not replacing a field). Capture a screenshot before coordinate input; the frame expires after 30 seconds and after any input. Chinese text, native selectors and flows need App mode. Never replay duplicate or uncertain inputs. A disconnect invalidates the session and requires a new explicit start.

Basic mode's pause/stop controls live on the desktop; it has no phone-side capsule, notification or accessibility protection. The UI refreshes screenshots periodically, not video. `run` and the dedicated `install` command require the App. `wrap`, `exec` and `app` also support an explicitly selected `--backend basic`; never choose it as an automatic fallback. To install ProfilePilot's App, first stop basic control, then use `ppilot phone update --device DEVICE_ID`; users confirm required Android permissions. The desktop offers the same transition through “结束控制并安装 App”.

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

Use the actual returned ID, which can be an IP:port or an mDNS service name. `connect --device` connects/opens the existing companion without installing or updating it; it does not start control. Use `update --device` for an authorized installation/update of the bundled companion. Connection can reuse an existing USB companion pairing after verifying the same hardware, but USB authorization is not proof of Android wireless-debugging pairing. Reconcile session ownership before switching transports; never use Wi-Fi to bypass a paused or occupied USB session. `wireless-disconnect --device` disconnects the selected Wi-Fi route after its tasks end and suppresses automatic reconnection until an explicit connection request.

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

`ppilot phone install --device DEVICE_ID --apk "/absolute/path/app.apk" --controller Codex` installs a local signed APK through ProfilePilot over the selected USB or Wi-Fi connection. It creates and ends its own control session; do not call `start` first. The companion must be ready and existing sessions must be ended with the user's authorization. `update` installs or updates the bundled ProfilePilot companion; `connect` leaves APK bytes unchanged. The `install` command handles other apps.

The command stages and verifies the requested APK bytes, uses Android's normal signature/update checks, and preserves existing app data. It does not uninstall, downgrade, grant permissions, launch the installed app, resume a paused session, or accept arbitrary ADB flags. Pause, disconnect, lease expiry or ownership changes stop the host installer; an Android install already submitted may still finish. Reconcile the actual result before any retry. A CLI success means Android returned `Success` under the same active session. Use normal `ppilot phone` actions for subsequent UI checks.

## Select and start

For installed versions, first use `ppilot phone inspect --device DEVICE_ID [--package com.example.app]` (defaults to ProfilePilot). It reads versionName/versionCode, timestamps, all APK paths and raw evidence without an App session or installation. Unknown fields remain null. Use `packages --device DEVICE_ID [--scope all|user|system] [--filter example]` for app discovery and `diagnose --device DEVICE_ID` for build/display/process/service/window diagnostics. Query failures do not prove absence.

Read [Managed ADB and app workflows](phone-adb.md) for Shell, files, logs, package export/lifecycle, split installation, forwarding, host diagnostics and maintenance commands. These are now managed `ppilot phone` capabilities; a raw ADB exception is unnecessary for supported operations.

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

Ordinary CLI input defaults to a 500 ms wait followed by an observation in the same response. `data.actionOutcome: "completed"` confirms input; `data.observationStatus: "available"` supplies `data.observation`. Android App returns its bounded accessibility tree (up to 400 nodes and depth 25); basic mode returns a fresh PNG path with width/height, usable for the next coordinate input. Basic images are saved under `~/.profilepilot/phone/artifacts/` or an unused `--output` path. This is a current sample, not complete history or proof that asynchronous work finished. `observationStatus: "unavailable"` means check control and read again, never replay input. `--no-observe` or JSON `observeAfter: false` skips this feedback. Read actions do not add another read. Flows, the ADB wrapper and live/continuous controls manage their own timing without a snapshot after each low-level input.

Read `sessionId` and `generation` from the current `list` response and generate a new UUID per new action. Supported action kinds are `snapshot`, `screenshot`, `tap`, `swipe`, `text`, `key`, `find`, `click`, `fill` and `scroll`. Screenshot output can be saved with `--output screen.jpg`; text replaces the focused input using Android accessibility. Inspect the current screen before selecting coordinates. View mode rejects input.

Prefer native selectors when the page exposes controls: `{"kind":"click","selector":{"resourceId":"com.example.app:id/save"}}`. Selectors match all supplied fields exactly: `resourceId`, `text`, `description`, `className`, `packageName`, `enabled`, `checked`, `editable`, `clickable`, `scrollable`. Use `find` to inspect matches; `click`, `fill` and `scroll` require exactly one match and resolve again on the phone at execution time. `fill` accepts `text` (including `""` to clear) without requiring focus. `scroll` takes `direction: "forward" | "backward"`. Ambiguity and incomplete/stale trees fail rather than choosing an arbitrary target. Do not blindly switch to coordinates after an uncertain action.

## Screen camera for a browser QR code

The screen camera supplies a computer image to an Android virtual camera. It requires a compatible Android 16+ device and ProfilePilot companion 0.3.0+, with an active App control session. It does not work in basic mode. Start with `ppilot phone camera probe --device DEVICE_ID`; a recent Android version alone does not guarantee virtual-camera or GPU support.

Use the already authorized browser Profile to capture the current QR code, including its white border. Keep browser and phone sessions separate. A UTF-8 `camera.json` contains the current phone lease, for example `{"id":"DEVICE_ID","sessionId":"CURRENT_SESSION_ID","generation":1}`. Use actual values from `ppilot phone list`.

```sh
ppilot phone camera start --params-file camera.json
ppilot phone camera frame --params-file camera.json --file qr.png
ppilot phone camera apps --params-file camera.json
ppilot phone camera preview --params-file camera.json --output scan.jpg
ppilot phone camera status --params-file camera.json
ppilot phone camera stop --params-file camera.json
```

For `camera launch`, add `component` from `camera apps` to a separate lease JSON. For `camera tap`, add `x` and `y` measured from a fresh 720 × 1280 camera preview. For `camera key`, add `"key":"back"`. These actions operate on the App's virtual display; ordinary `phone action` coordinates belong to the phone's main display. Launch the scanning App there, open its scanner, and verify its result. Stop the camera and finish only the phone session you own. Pause/takeover, disconnect and lease changes revoke camera input; never auto-resume or repeat an uncertain tap or launch.

For continuous window capture, list `camera sources`, then add its exact `sourceId` and optional normalized `crop` (`x`, `y`, `width`, `height` between 0 and 1) to the start parameters. The selected window is never replaced automatically if it closes. macOS requires screen recording permission. The desktop **手机 → 屏幕摄像头** dialog provides the same source selection and App preview. A successful start or frame upload is not evidence of a successful QR scan; verify the scanning App and the original browser page.

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

For existing scripts, `ppilot phone wrap --device DEVICE_ID --controller AGENT_NAME --task TASK_DESCRIPTION --mode view -- PROGRAM ARGS` starts a managed process with the ADB adapter described in [Managed ADB and app workflows](phone-adb.md). Use control mode for authorized input. A tool that hardcodes a native ADB executable or opens a direct ADB socket is not automatically covered by `wrap`. Do not bypass the managed route after a rejected operation. On Windows use an actual executable, or an explicit interpreter for scripts and .cmd files.

## Pause and finish

Before starting, `ppilot phone readiness --device DEVICE_ID` (alias `doctor`) reports transport, boot, companion version, accessibility, overlay, notifications and session ownership together. Capability fields distinguish native selectors, screenshots and input; a working ADB transport alone does not prove App control is ready. `ppilot doctor --device DEVICE_ID --json` includes desktop/CLI versions. A missing permission fails start before a session RPC. Do not construct `action` from a failed start or a null sessionId. Failures include `recovery` with cause, stage and action outcome; a rejected or timed-out action is not automatically replayable. Inspect `--backend basic` only when that mode is intended; readiness never switches backends or takes over an existing App session.

- Use `ppilot phone pause --device DEVICE_ID` for a pause and `ppilot phone stop --device DEVICE_ID` when your task finishes or is cancelled. Managed `wrap` tasks normally end their owned session when the process exits.
- A user pause, stop or disconnect invalidates queued actions. Stop issuing input, read fresh state and wait for explicit return of control before resuming your own session. Do not resume automatically or replay a failed action with a new UUID.
- The phone checks session identity, generation and heartbeat. Its pause/stop controls remain authoritative regardless of preference text. A suspended Agent task does not imply permission to keep controlling the phone.

## Screen off and unlocking

A control session keeps the display awake by default (`keepScreenOn`); `ppilot phone start ... --keep-screen-on off` opts out. If the screen still turns off, the phase becomes `paused` with `pauseCause: "screen"` and the UI says “等待解锁”. That state resumes by itself once the phone is awake and unlocked — do not call `resume`, and never treat the pause as a manual takeover. A `pauseCause: "manual"` (or `permission`) pause is different: it requires the user's explicit resume.

`ppilot phone wake --device DEVICE_ID` sends `KEYCODE_WAKEUP` and attempts to dismiss an unsecured swipe keyguard. `ppilot phone unlock --device DEVICE_ID` reads a PIN or password from stdin (never argv), swipes up, types it and submits. For a pattern lock use `--pattern 1478` (4–9 unique digits 1–9): the desktop draws one continuous DOWN/MOVE/UP gesture, auto-detects the dot grid from the lock screen when possible, and reuses or estimates the geometry otherwise. The pattern digits never reach the device — only converted coordinates. `--pattern-geometry cx,cy,step` overrides a misdetected grid.

For unattended work while the phone is locked and asleep, the companion App has an opt-in “无人值守” switch (Settings → “充电时保持 ADB 响应”): while plugged in it holds a partial wake lock and Wi-Fi lock so the screen may sleep and the keyguard may lock, but ADB stays reachable. It releases on unplug, disable or service exit. Use `ppilot phone unattended --device DEVICE_ID --op on|off|status` to read or toggle it; enable it only when the user intends remote work, and never as a silent background wake-up. It is not a lock bypass — unlocking still needs the saved credential.

The desktop can hold one encrypted unlock credential per phone (App: the ⋮ menu on the device row → “解锁凭据”; also under device details → more settings; it does not require the phone to be connected. CLI: `--save --kind pattern|credential` reads stdin, `--forget` deletes). `ppilot phone unlock --device DEVICE_ID --stored` uses it without exposing the value; it refuses when the saved record has “允许命令行与 Agent 使用” turned off. Only use `--stored` when the user has explicitly saved a credential for unattended work: it means this computer may unlock the phone while they are away. The vault is OS-encrypted, but any code running as the same desktop user can ask the App to decrypt and use it; it protects a lost phone, not a compromised PC. Never ask the user to paste a PIN or pattern into the conversation; point them to the App field instead.

Both are user-authorized device actions: run them only when the user asks to unlock their own phone, and never guess or brute-force a credential. A failed or unconfirmed `unlock` is not retried; report the uncertain result and let the user check the phone. Do not attempt to bypass a lock screen by other means.
