# ppilot browser CLI: Gateway connection

Use `ppilot browser` for managed Chrome or registered Electron apps. ProfilePilot includes its own TypeScript browser engine and guarded Wrapper; users install only the CLI from the app. Read `ppilot browser --connection gateway --help` for the bundled engine's supported commands. Familiar snapshot/click/fill syntax remains available after the unified prefix.

```text
Agent → ppilot browser CLI → internal driver + control protection → Gateway → Chrome/Electron
```

Connection options must precede the command. `--cdp` selects Gateway and takes the target's actual **logical port**. Without it, the default connection is the extension; select `--connection gateway` explicitly for Gateway lifecycle/catalog commands without a port. Never infer the route from a coincidentally matching session name.

The port below is an example; discover the intended Profile with `ppilot browser --connection gateway profiles`. Use a task-specific session consistently, or preserve the session supplied by the Agent host:

```sh
ppilot browser --session research --cdp 9223 open https://example.com
ppilot browser --session research --cdp 9223 snapshot -i
ppilot browser --session research --cdp 9223 click @e3
ppilot browser --session research --cdp 9223 status
```

The CLI acquires the session and may start the bound Profile. It translates the logical port to Gateway's authenticated transport. Do not probe `/json/*`, copy a WebSocket URL, add Chrome debugging flags, replace the session, or launch a separate browser after a stop. Conflicts do not automatically select another Profile or connection. If the bundled driver is missing, update/reinstall the CLI through ProfilePilot's tool setup.

## Handoff and finish

When a visible CAPTCHA interrupts the task, first let the current Agent inspect the same session's snapshot and screenshot using [the current-conversation workflow](captcha.md). Continue with ordinary guarded browser actions when it can solve the puzzle; do not spawn a separate model just to read the image. Use handoff when user participation is actually needed.

`ppilot browser --session research --cdp PORT handoff --reason "Complete sign-in"` gives the user control while preserving the session. Stop commands and explain the required action. After explicit return, run the same prefix with `resume`, then `snapshot -i`. `wait-control` can wait for the control UI; `AGENT_CONTROL_RETURNED` requires a new snapshot and `AGENT_TASK_STOPPED` ends the task.

On success use the same prefix with `complete` before the final response. On cancellation use `release`. Do not reconnect a completed session or complete while waiting for a required user action. `PROFILEPILOT_PENDING_USER_ACTION` means the task is still waiting.

`AGENT_USER_IN_CONTROL`, `PROFILE_LEASE_CONFLICT`, `SESSION_ALREADY_BOUND` and exit 75 are stops. A recommended free Profile may be selected only when the user authorized that switch. `GATEWAY_PROFILE_NOT_CONFIGURED` needs the intended Profile configured, not an unmanaged browser.

## Registered Electron apps

Use `ppilot electron list --all` to inspect all registrations and `ppilot electron inspect ACTUAL_ID --session TASK` for ownership-aware routing and an exact next command. If the intended app is absent, `ppilot electron schema register` describes the supported registration input; `register --params-file` only saves it and never starts or connects the app. Inspect it, then use the supported `connect` path within the user's authorization. A connection or restart confirmation still applies. `ppilot doctor --electron ACTUAL_ID --session TASK` provides the same preparation guidance without taking control.

Prefer the dedicated `ppilot electron` entry. Run `ppilot electron list` to discover registered Gateway applications and their logical Agent ports, then use `ppilot electron --session TASK --cdp PORT snapshot -i` (or `click`, `fill`, `screenshot`, `status`, `handoff`, `complete`). It shares the guarded page engine and session lifecycle, but rejects browser Profiles and extension connections. Native menus, tray icons and system dialogs are outside this page interface. The older `ppilot browser --cdp PORT` spelling remains compatible; keep the route explicitly selected by the user or personal preferences.

Application paths, launch arguments and connection settings belong to the app's registration in Local Apps. Read them with `ppilot electron inspect`; background operation and handoff follow the shared Skill rules.

Verify the app is registered in ProfilePilot Local Apps with its own Agent logical port and renderer debugging ready. Use that logical port, not its native debug port or a Chrome Profile's port. Normal snapshots/reads/clicks/screenshots can stay in the background: Gateway suppresses Agent activation calls. Do not relaunch, show, focus or open DevTools just to inspect the app. Windows `windowsHide` only hides a console; macOS and Windows applications may still focus themselves on startup. Without the required debugging connection, report the limitation rather than claiming Gateway verification.

## Additional managed operations

For preview fixtures and restart tests, apply the [foreground-preservation rules](../SKILL.md). Start Electron fixtures with `show: false` when visibility is unnecessary; if a visible window is required, prefer a supported nonactivating path such as `showInactive()` and verify that it leaves the user's focus alone. Application handlers can still activate a window after launch or reload. Prefer background lifecycle commands and keep UI-opening flags out of automatic restarts. If background capture is unavailable, report that gap rather than repeatedly showing or focusing the window. Selecting an Agent page must not implicitly activate the user's browser tab.

Use the same `ppilot browser --session TASK --cdp PORT` prefix for:

- `extension load-unpacked ABSOLUTE_DIRECTORY` for a user-authorized unpacked extension. Use the controlled command before a native file picker; a capability failure may require user installation.
- `device emulate iphone-16-pro`, `device status`, `device clear`. Ordinary handoff/end clears emulation. `handoff --keep-device-emulation` is for explicit manual device verification.
- `cdp capabilities`, then `cdp call METHOD --params-stdin` if supported. The controlled bridge keeps Gateway ownership and method restrictions. Extension-route `ppilot browser cdp METHOD` has different arguments; do not mix the two connections.

Compatibility: the former `agent-browser --cdp PORT COMMAND` maps to `ppilot browser --cdp PORT COMMAND`; `agent-browser profilepilot ACTION` maps to `ppilot browser --connection gateway ACTION`. Do not require the legacy launcher for new tasks.

## Engine behavior

See [Network, Console and performance inspection](browser-debug.md) for the
shared debug commands. `profiler` produces Chrome performance JSON; the existing
Gateway `trace` command continues to produce Playwright Trace ZIP.

The common contract also supports `observe [--output PATH]` and `action --params-file ACTION.json` (or `--params-stdin`). Use `ppilot browser schema` for supported actions and fields. Observe returns an `ok/result` envelope with version, DOM, refs and separate screenshot/coordinate availability; an action must carry that version and consumes it. Use UTF-8 JSON files for Chinese text and literal quotes on both Windows and macOS. Legacy snapshot/click commands keep their existing format; quote legacy PowerShell refs such as `'@e3'`. `doctor` aliases the guarded Gateway readiness check. Read `recovery.actionOutcome` after a common-command failure and never replay unknown input.

Successful page actions, navigation and frame/tab selection wait 500 ms and return `actionOutcome: completed`, `observationStatus` and a fresh `observation` containing version/refs. Use those returned refs for the next step; the previous refs are consumed. An unavailable observation does not mean input failed: check control or observe again without replaying input. Read-only commands, raw eval/CDP, keydown/keyup, mouse down, close and control handoff do not add a snapshot. This bounded settling delay does not guarantee asynchronous business completion or retain transient message history. After control return or later page changes, obtain a new observation. Closing the selected tab requires an explicit `tab ID` before further page actions. `tab list` remains available for recovery. Electron targets retain Gateway restrictions on creating or closing application windows.

Gateway/Electron support the prefix `--no-observe` for a caller that already observes after a composite operation. The built-in Agent uses this internally so intermediate scroll/paint preparation does not replace the pending click's refs; it returns one observation after the complete action. Keep automatic feedback enabled for ordinary Agent CLI use.

`batch --stdin` accepts a JSON array of command argument arrays. `--bail` stops at the first failure; any failed row makes the overall command fail. A batch cannot change session or connection, connect, disconnect, or nest another batch. Use the regular guarded lifecycle commands separately.

Commands run serially in a session. A transport timeout never causes action replay. After an uncertain timeout, inspect session/page state before deciding what to do next. Use the installed command help; this engine does not include upstream cloud-provider integrations.
# Website adapters

Supported search, detail and comment operations are also available through the
same Gateway session. See [structured website reads](site-adapters.md).
