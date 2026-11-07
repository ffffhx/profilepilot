# Command discovery, recovery and usage traces

Read only the schema for the selected route and command. Examples:

```sh
ppilot phone schema action
ppilot desktop action --help
ppilot electron schema register
ppilot browser --connection extension schema newTab
ppilot browser --connection gateway schema action
ppilot gpui schema call
```

Schemas describe inputs; they do not establish a connection or authorize a session. Discover actual target IDs first. Use the corresponding `doctor`/`inspect` result's recommended route, available operations and next command. Electron `register` saves a registration only; `connect` is a separate step and any required restart confirmation still applies. A route error does not authorize desktop fallback or replacing the user's Profile.

For JSON commands, use a UTF-8 `--params-file` (BOM accepted) or supported `--params-stdin`; do not supply both. On Windows use the installed `ppilot.ps1` entry and quote refs such as `'@e123'`. If calling Node or `.cmd` directly from PowerShell 5.1, use a UTF-8 file or explicitly set UTF-8 pipe encoding. Keep stdout and stderr separate when parsing JSON; merging a PowerShell NativeCommandError into JSON destroys the response.

Recovery fields distinguish validation, prerequisites, ownership and execution. An input rejected before dispatch is `not-executed`; fix the reported input or readiness condition within the existing task authorization. For `unknown`, inspect the result/receipt before deciding whether another action is needed. `requiresUser` describes a necessary user action, not an instruction to ask for permission again on every step. A user-controlled session cannot be resumed by technical recovery.

`NATIVE_FRAME_SESSION_STALE` identifies a lost child-frame debugger session. Observe/read may rebuild the same authorized target's cache once. If that bounded recovery fails, inspect the connection; do not loop on observe, release/reclaim another task's session, or replay a write. With `NATIVE_RENDER_UNAVAILABLE`, inspect partial DOM and availability: successful text observation does not make an old screenshot safe for coordinates.

When measuring a task, explicitly label it and keep the same task ID across steps:

```sh
ppilot --task-kind real --task-id phone-task phone list
ppilot --task-kind verification --task-id ui-check --operation-id initial-observe desktop observe --session acceptance
ppilot trace report --since 14d --task-kind verification --json
```

Metadata flags must precede the route (`browser`, `phone`, etc.); command text and script arguments after the route are never reinterpreted as trace options. For a repeated logical step, keep its `--operation-id`. A distinct recovery step can reference the failed step with `--recovery-of STEP`. These labels only correlate metadata; they never authorize retries, connection changes or user-control resumption. Use opaque IDs rather than personal information. IDs are hashed on disk; input text, URLs, credentials, images and arbitrary errors are omitted. Omitted task kind remains `unspecified` rather than being guessed from the command.

The report separates real/verification/unspecified samples. First-attempt success needs explicit operation IDs. Commands before the first effective operation include discovery and failed calls; a successful observe/read/screenshot or productive action is effective. Recovery duration uses explicitly linked operations. User-intervention reasons count responses requiring user action, not how many times a person actually intervened. Bounded, best-effort logs and the chosen time window may omit earlier steps; do not present these samples as complete task success rates. Service traces are excluded from CLI totals to prevent double counting.
