# ppilot gpui: GPUI debugging

Session state is drawn inside the target GPUI application's bottom-right corner using its annotations capability. No separate control window opens. This works for compatible GPUI applications, not only Herdr. The chip is informational and does not intercept clicks. The existing GPUI page and tray provide user controls; opening the page never returns paused control. Hiding/minimizing ProfilePilot or switching its page does not pause a session. Unavailable annotation support is reported in the GPUI page without opening a fallback popup. GPUI element input is dispatched inside the application without global mouse/keyboard injection. Background and minimized windows are different: the current Windows screenshot backend requires the target window to remain unminimized.

Use `ppilot gpui --help`, then `list` and `status`. ProfilePilot must be running. The first backend is the pinned gpui-mcp bridge protocol 14; the application needs a compatible instrumented development build. Do not infer semantic accessibility or CDP from the fact that an app uses GPUI.

Select the exact `target_id` returned by discovery, then:

For preparation, `ppilot gpui doctor --target TARGET_ID --session TASK` reports readiness without claiming control. `ppilot gpui schema call` describes CLI arguments; `ppilot gpui schema click_element` retrieves the actual installed backend's tool input schema through `tools/list` without selecting an application. A missing backend requires setup, not a guessed tool schema.

```text
ppilot gpui claim --target TARGET_ID --session TASK
ppilot gpui snapshot --session TASK
ppilot gpui call --session TASK --tool click_element --params-file click.json --observation UUID
ppilot gpui snapshot --session TASK
ppilot gpui call --session TASK --tool screenshot --output ABSOLUTE_NEW_FILE.png
ppilot gpui complete --session TASK
```

Use UTF-8 JSON files for arguments, including Chinese text. Element input uses stable IDs from the latest snapshot. Every mutation consumes its observation UUID. Inspect bounds, role, state and label before acting; stale observations are rejected. Prefer `set_text` with `{ "id": "input-id", "text": "..." }`; keyboard syntax follows GPUI (`ctrl-a`, `enter`, etc.). Use `get_logs`, `get_frame_report`, `record_performance` and `highlight_elements` for debugging. `record_performance` accepts `duration_ms` up to 10000. The exact supported list is in CLI help.

`handoff` pauses and preserves ownership. A clear instruction in the current conversation to return control authorizes `return-control` for that same target and session without another permission question.

When the user explicitly returns control in the current conversation, read `ppilot gpui status --json`, verify the original target and session, and run `ppilot gpui return-control --session TASK --pause-id PAUSE_ID_FROM_STATUS`. This is the supported management action for chat-authorized return; no app click, host signing integration or repeated permission question is required. The caller is responsible for obtaining the user's explicit consent. `pauseId` identifies one pause; it is not proof of authorization. A new takeover, service restart or recreated session invalidates old IDs. If the user takes over again, stop and wait for a new explicit return; never fetch new IDs in a loop to defeat takeover. Inspect failed/unknown results without replaying operations. After successful return, take a fresh snapshot. The legacy `resume` command only checks already active state. If the installed version lacks `return-control`, update the app and CLI through their normal build/start workflow. Do not edit session files, switch routes/targets, or automate the user's return button to work around an outdated controller.

Exit 75, timeout, connection loss, or takeover means inspect state and reconcile outcomes. An input may already have happened; never replay it automatically. Normal completion uses `complete`, cancellation uses `release`; a paused reservation requires the user's explicit return, through chat-authorized `return-control` or the in-app return/stop action. Current physical takeover detects target-window mouse clicks; it does not guarantee detection of every keyboard input, so pause from the GPUI page or tray before typing manually.

Backend setup: build the pinned version with `node scripts/build-gpui.mjs`, or choose a compatible local executable with `configure --backend ABSOLUTE_PATH` / the management page. Build and application-side Rust integration instructions are in `docs/gpui-debug.md` in the ProfilePilot source. gpui-mcp's optional HTML live-edit runtime is distinct from arbitrary Rust component style hot reload; the latter is not provided by this CLI.
