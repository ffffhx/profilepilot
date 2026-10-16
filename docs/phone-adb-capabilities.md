# ProfilePilot / ADB capability audit

Task: obtain upstream ADB source, compare ProfilePilot's Android capabilities, and close the gaps. REA is an analysis reference; ProfilePilot is the implementation target.

## Evidence

- AOSP ADB checkout: sibling `adb-source`, commit `1cf2f017d312f73b3dc53bda85ef2610e35a80e9`, https://android.googlesource.com/platform/packages/modules/adb/
- Command inventory: `client/commandline.cpp` (`help` and command dispatch); transport, shell, file sync, package installation and forwarding implementations are in the same checkout.
- REA checkout: sibling `rea-reference`, commit `2c7583599b9ac1c847bd77b1940930fd8d4594c7`, https://github.com/morluto/rea
- REA references: `docs/adb-device-analysis.md`, `src/adb/AdbProvider.ts`, `src/domain/adb/adbDeviceAnalysis.ts`. Reference only; no REA source is copied into ProfilePilot.
- ProfilePilot baseline: `3b6dace`; existing unrelated site/privacy edits are outside this task.

## Requirements and status

The table distinguishes command availability from physical-device validation. Device mutations were tested on owned temporary artifacts; personal app data and system configuration were not test fixtures.

| Capability | Baseline | Completion evidence / remaining work |
| --- | --- | --- |
| Select devices, USB/Wi-Fi identity, discovery, pairing | Implemented | Preserved; added actual `transportId`, scoped `-t`, corrected `-e` to TCP/Wi-Fi/emulator. Wrapper and wireless tests pass. |
| Query installed package/version without installing companion | Missing | `phone inspect`: exact package version/name/code, timestamps, split paths and raw evidence; verified on RMX3700. |
| Connect without implicit install/update | Missing in CLI | CLI `connect` only connects; `update` explicitly installs bundled companion. Existing desktop setup keeps its install behavior. Tests cover both. |
| Device/build/display/features/services/settings/process diagnostics | Mostly missing in CLI | `diagnose` returns bounded fixed queries, properties, raw evidence and partial failures. `exec` supports settings reads. Live diagnosis returned complete coverage. |
| List/search apps, inspect versions/paths, export split APKs | Missing | `packages`, `inspect`, `app export`; exclusive output directory, SHA-256 and partial artifacts. Split/partial cases tested; real companion APK exported and hash checked. |
| Launch activities/apps, force-stop/uninstall, install splits | Only single APK install | Typed `app launch/stop/uninstall`; managed `install-multiple/install-multi-package`. Lifecycle/quoting/export workflow tests; no personal apps uninstalled. |
| Shell and exec-in/exec-out, stdin, binary output, remote exit code | Only fixed input/screenshot grammar | Desktop-owned streaming jobs and `exec`/wrapper integration. Live exit 17 and separate stderr verified; 256 KiB binary stdin/stdout verified through exec channels. Windows shell limitation below. |
| Text, full key events, long press and other input commands | Basic UI operations only | Extended `input` commands use native ADB semantics under control lease; existing common tap/swipe/navigation/screenshot path preserved. Wrapper regression tests pass. |
| Push/pull files and directories; sync | Missing | Native transfer commands retain argv/cwd and platform-tools behavior. Live file with spaces round-tripped byte-for-byte. `sync` uses the desktop process's `ANDROID_PRODUCT_OUT`. |
| Logcat, dumpsys, bugreport, screenrecord, process debugging | Missing except screenshot | Managed bounded streaming/timeout/cancellation; `jdwp`, `track-jdwp`, `track-app`, and shell tools exposed. Live bounded logcat and diagnosis pass; bugreport/recording were not run on personal phone. |
| Forward/reverse sockets | Internal companion forwarding only | Task-owned `--no-rebind` mappings, exact-match cleanup and persistent orphan journal. Tests cover external replacements, failed cleanup and restart recovery. Live forward cleaned at wrapper exit. |
| Wait/reconnect/disconnect and transport transitions | Partial | Managed device wait/reconnect and explicit Wi-Fi disconnect. Shared `reconnect offline` restricted to host path. Losing transport invalidates lease and yields an uncertain result; never auto-replays. |
| Root/unroot/reboot/remount/verity/sideload/USB/TCPIP | Missing | Exposed under a valid control lease, preserving Android permissions and native errors. No destructive physical-device test; recovery-only targets remain outside normal App/basic sessions. |
| ADB host diagnostics/server lifecycle/emulator console | Partial | `phone host` for diagnostics, mDNS, keygen and server lifecycle; device `emu` under control. Shared server changes reject active/paused tasks. Tests verify kill-server stays stopped until explicit start. |
| Pause/stop/session expiry/disconnect | Existing App and wrapper leases | All managed processes check generation/ownership, cancel on revocation and reject replay/stdin after pause. Live pause stopped a running command with exit 75 and released its owned session. |
| CLI help, bundled skill, installed CLI, running desktop | Existing distribution | Help and phone references synchronized with plugin; installed CLI refreshed on independent desktop restart. Full phone UI and real-preload regression passed. |

## Design facts

ADB is already ProfilePilot's transport. The gap is the user-facing command surface, structured results and lifecycle management, not a missing USB protocol implementation. Reusing the installed platform-tools executable preserves upstream Windows/macOS behavior and Android permission checks.

REA separates fixed read operations from mutations, preserves raw evidence and partial failures, snapshots upload inputs, and keeps binary transfers out of text shells. These are useful design references. Its Android provider intentionally does not expose all ADB commands; it cannot stand in for the upstream command inventory.

Pausing can stop a local ADB process and prevent subsequent commands. It cannot undo a completed device mutation or guarantee termination of an intentionally detached remote process. Results and instructions must state this limitation instead of claiming rollback. Forwarding resources created by a task need explicit ownership and cleanup.

## Verification ledger

- Source checkouts verified by Git HEAD against the pinned commits above.
- Before this task: real RMX3700 updated through `ppilot phone connect` from `0.3.6+local.190-dev` to `0.3.6+local.193-dev`; current package version query previously required raw ADB.
- `npm run check`, `npm run build`, plugin synchronization/validation passed.
- Phone/ADB regression suite: 192 tests (includes new persistent forwarding restart test); full phone UI fixture and real application/preload/IPC boundary passed via `node scripts/e2e-phones.mjs`.
- Live Windows + RMX3700 over Wi-Fi: 14 checks in `artifacts/phone-adb-live/32f903a9-9c21-46b8-ac5c-a6498c5ae95b/report.json`; diagnosis, search, version, exit code, binary streams, push/pull, logcat, APK export and mapping cleanup. Temporary remote file removed.
- Separate live pause result: `artifacts/phone-adb-live/pause-report.json`, exit 75, final phase `stopped`. Previous unrelated phone task had already ended before live acceptance began.
- Native Windows `shell -T cat` was also tested: random input truncated at Ctrl-Z. The test's initial large Buffer assertion exhausted Node memory while printing the difference; it was replaced with bounded equality checks. Confirmed against upstream `adb_shell`/`raw_stdin` and binary `copy_to_file` paths. No remote mutation was pending from that failed attempt.
- Physical macOS, root/reboot/recovery, split installation and long bugreport/recording are not claimed as live-tested. Portable spawn uses argv arrays, no host shell, and platform-specific wrapper tests cover Windows/macOS selection and environment behavior.

## Compatibility boundaries

This is a managed phone command surface, not a fully interchangeable ADB server.

- `exec-in` is stdin-only and `exec-out` stdout-only, with upstream ADB's exit-status limits. Ordinary shell reports remote exit codes. On Windows, noninteractive shell stdin is text-mode; arbitrary binary data must use exec-in/exec-out or push/pull. This was a real cross-platform difference, not a JSON/base64 transport error.
- Sessions require an authorized online device. Commands that reboot or drop the connection can invalidate their own lease; exit 75 means inspect the resulting state before any further action. Waiting for/recovering an already offline, bootloader-only or recovery-only device is not a substitute for starting a valid session. Root and recovery support depend on the Android build and permissions.
- Server selection/listen flags (`-H/-P/-L/-a`), daemon hosting, arbitrary `raw` protocol requests, inherited `acceptfd`, legacy backup/restore and host device-tracking streams are not exposed. They either bypass device ownership, require separate host lifecycle design, or are legacy interfaces. `phone list` and wireless management remain the supported discovery routes.
- Native ADB command flags and local transfer destinations retain native semantics. Structured APK export and `output` require new destinations; generic `pull`, `push`, installation and shell can modify their explicit targets. These operations require task authorization.
- The desktop owns native processes and bounds unread output at 8 MiB. A stalled consumer or interrupted session can leave partial files. Stopping a process cannot roll back completed mutations or kill an intentionally detached remote process. No retry/resume is automatic.
- Forwarding cleanup compares device/endpoint/destination before deletion. An external actor that removes and recreates an identical mapping is indistinguishable in ADB's listing; simultaneous native tools should not reuse a managed task's endpoints.
- No Android source changes were needed. This task changes desktop/CLI capability and bundled instructions; it does not create a new Android release or publish desktop installers.
