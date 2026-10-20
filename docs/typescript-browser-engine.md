# TypeScript browser engine migration

The requested end state is a project-owned TypeScript browser engine used by
`ppilot browser` and desktop browser tasks, with no agent-browser Rust runtime
dependency. The default extension connection and Gateway ownership, takeover,
resume, completion, and isolation rules remain functional.

The engine uses the JavaScript implementation of Playwright Core for CDP,
accessibility snapshots and DOM interactions. It connects to the existing
Gateway; it does not launch an alternative browser after a connection failure.
The extension connection continues to use the existing TypeScript browser
service and Chrome extension.

Gateway protocol 19 restores browser-level Auto-Attach during reconnection.
An older Gateway holding live browser pipes is not forcibly replaced. The CLI
returns `GATEWAY_UPGRADE_REQUIRED` before input until those managed connections
are ended and ProfilePilot can upgrade the daemon.

## Acceptance

- Replace the bundled Rust driver with a TypeScript command engine and persistent
  session service. Validate inputs and preserve JSON responses and exit behavior.
- Implement navigation, accessibility snapshots and element refs, selectors,
  click/fill/keyboard/pointer/scroll, getters, waits, tabs/windows/frames,
  screenshots/PDF, upload/download, cookies/storage, network, dialogs, settings,
  evaluation, state and diagnostic commands used by the public browser interface.
- Integrate the engine into CLI installation, desktop tasks, Gateway lifecycle,
  process identification, build and Windows/macOS packaging.
- Remove the agent-browser package and packaged native binaries. Keep existing
  compatibility command names where they protect integrations.
- Verify real browser behavior, ref invalidation, iframe/shadow DOM, session
  persistence, concurrent calls, takeover/return and completion without closing
  the user's browser. Verify CLI and task paths, and run relevant regressions.
- Launch the updated desktop app as an independent process and verify it remains
  alive. Do not edit README or trigger release workflows.

## Implementation and verification

Implemented in `src/main/browser-engine`, with a physical JavaScript runtime in
`dist/browser-runtime`. The CLI, compatibility launcher and desktop task adapter
resolve this runtime. Playwright Core is pinned to 1.64.1. No agent-browser
package, Rust browser executable, browser download, or global Node install is
required by the packaged application.

The authenticated session service serializes commands and never replays an
action after a transport timeout. Gateway remains responsible for ownership,
takeover and stop. Reconnection preserves the selected CDP target, including
when multiple tabs have identical URLs; a closed target requires explicit
selection. Snapshot refs expire on navigation, new snapshots, frame/tab changes
and control transitions.

Windows validation on 2026-10-20:

- `npm run build` passed.
- Full regression run: 1789 passed, 3 skipped. Follow-up checks covered the final
  transport, runtime, CLI, launcher and upgrade changes.
- `scripts/verify-typescript-browser.mjs` passed real Chrome checks for refs,
  Chinese/flag-like input, shadow DOM, same-origin and cross-origin iframes,
  screenshot annotations, PDF, files, cookies/storage/state, network routing,
  keyboard, dialogs, trace, batch failures, concurrent calls, desktop tasks,
  exact tab recovery, session conflict, takeover/return and completion. Browser
  processes remain alive after completion.
- The Electron variant passed main-window and same-origin iframe commands,
  desktop tasks and lifecycle checks. Gateway still denies creating Electron
  application windows.
- The installed `ppilot` and legacy launcher report the TypeScript engine.
  The development desktop app was independently restarted through Explorer and
  its running window was checked.
- Packaging checks validate both source and final copied runtime dependencies.
  The Windows runtime was exercised using packaged Electron with an empty PATH.

Limitations: this is the documented ProfilePilot command surface, not every
upstream agent-browser provider/plugin. Electron cross-origin iframe interaction
is not accepted as verified: its offscreen test fixture did not reliably apply
native input. macOS resource layout, runtime selection, modifiers and detached
launch paths were inspected and structurally tested; no macOS machine was
available for end-to-end verification.

Re-run `npm run verify:browser-engine` for isolated Chrome and Electron checks.
For packaged Windows verification, set `PP_ENGINE_HOST` to the packaged
`ProfilePilot.exe`, `PP_ENGINE_CLI` to its
`resources/app.asar/dist/main/profilepilot-cli.cjs`, and
`PP_ENGINE_EMPTY_PATH=1` before running `scripts/verify-typescript-browser.mjs`.
