# ppilot browser CLI: Gateway connection

Use `ppilot browser` for managed Chrome or registered Electron apps. ProfilePilot includes the agent-browser driver and guarded Wrapper in this CLI; users install only the CLI from the app. For general driver operations, read `ppilot browser --connection gateway skills get core`. Existing agent-browser syntax such as snapshot/click/fill remains available after the unified prefix.

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

`ppilot browser --session research --cdp PORT handoff --reason "Complete sign-in"` gives the user control while preserving the session. Stop commands and explain the required action. After explicit return, run the same prefix with `resume`, then `snapshot -i`. `wait-control` can wait for the control UI; `AGENT_CONTROL_RETURNED` requires a new snapshot and `AGENT_TASK_STOPPED` ends the task.

On success use the same prefix with `complete` before the final response. On cancellation use `release`. Do not reconnect a completed session or complete while waiting for a required user action. `PROFILEPILOT_PENDING_USER_ACTION` means the task is still waiting.

`AGENT_USER_IN_CONTROL`, `PROFILE_LEASE_CONFLICT`, `SESSION_ALREADY_BOUND` and exit 75 are stops. A recommended free Profile may be selected only when the user authorized that switch. `GATEWAY_PROFILE_NOT_CONFIGURED` needs the intended Profile configured, not an unmanaged browser.

## Registered Electron apps

Verify the app is registered in ProfilePilot Local Apps with its own Agent logical port and renderer debugging ready. Use that logical port, not its native debug port or a Chrome Profile's port. Normal snapshots/reads/clicks/screenshots can stay in the background: Gateway suppresses Agent activation calls. Do not relaunch, show, focus or open DevTools just to inspect the app. Windows `windowsHide` only hides a console; macOS and Windows applications may still focus themselves on startup. Without the required debugging connection, report the limitation rather than claiming Gateway verification.

## Additional managed operations

Use the same `ppilot browser --session TASK --cdp PORT` prefix for:

- `extension load-unpacked ABSOLUTE_DIRECTORY` for a user-authorized unpacked extension. Use the controlled command before a native file picker; a capability failure may require user installation.
- `device emulate iphone-16-pro`, `device status`, `device clear`. Ordinary handoff/end clears emulation. `handoff --keep-device-emulation` is for explicit manual device verification.
- `cdp capabilities`, then `cdp call METHOD --params-stdin` if supported. The controlled bridge keeps Gateway ownership and method restrictions. Extension-route `ppilot browser cdp METHOD` has different arguments; do not mix the two connections.

Compatibility: the former `agent-browser --cdp PORT COMMAND` maps to `ppilot browser --cdp PORT COMMAND`; `agent-browser profilepilot ACTION` maps to `ppilot browser --connection gateway ACTION`. Do not require the legacy launcher for new tasks.
