# Managed ADB and app workflows

Read [phone.md](phone.md) and personal phone preferences first. Use the actual device ID from `ppilot phone list`. Keep the user's device, session ownership, pause/stop and task authorization authoritative.

## One command

Write a UTF-8 JSON file, then run:

```sh
ppilot phone exec --device DEVICE_ID --params-file command.json --controller Codex
```

Examples (one object per file):

```json
{"args":["shell","getprop","ro.build.version.release"]}
{"args":["logcat","-d","-t","200"],"output":"/absolute/new-log.txt"}
{"args":["push","/absolute/local-file","/data/local/tmp/task-file"],"timeoutMs":600000}
{"args":["pull","/sdcard/Download/example.txt","/absolute/output-directory"],"timeoutMs":600000}
{"args":["exec-in","sh","-c","cat > /data/local/tmp/task-input.bin"],"input":"/absolute/input.bin"}
{"args":["exec-out","cat","/data/local/tmp/task-input.bin"],"output":"/absolute/new-output.bin"}
{"args":["install-multiple","-r","/absolute/base.apk","/absolute/split.apk"],"timeoutMs":600000}
```

`exec` creates and finishes its own task. It selects view mode only for recognized queries; other commands require control. `--mode view` can impose a read-only limit. Raw shell syntax is preserved; quote device-shell values correctly. Structured app commands quote package/component values for you. Binary streams, stderr and native exit codes are retained. Upstream `exec-in` only sends stdin and `exec-out` only reads stdout; neither reports remote exit status. Use ordinary `shell` for remote exit codes. Windows ADB's noninteractive shell stdin uses text mode (Ctrl-Z can end input); use `exec-in`/`exec-out` or push/pull for arbitrary binary data. `output` must be a new local file. Interrupted/uncertain execution returns 75 and must be reconciled, never replayed automatically. Default timeout is 120 seconds, configurable up to one hour. Unread output is bounded at 8 MiB. For interactive input use `stdin:true`; for files prefer `input` to avoid PowerShell encoding changes.

## App lifecycle and acquisition

Run `ppilot phone app --device DEVICE_ID --params-file app.json --controller Codex` with:

```json
{"operation":"launch","packageName":"com.example.app"}
{"operation":"stop","packageName":"com.example.app"}
{"operation":"uninstall","packageName":"com.example.app","keepData":true}
{"operation":"export","packageName":"com.example.app","outputDir":"/absolute/new-directory"}
```

Export preserves all installed split APKs, local SHA-256 digests, raw command evidence and partial artifacts if interrupted. The output directory must be new. Stop/uninstall have their normal Android effects and require task authorization; do not use a user's personal app as a disposable test fixture. Install flags in `exec` have native ADB semantics; do not add downgrade, permission-grant or destructive flags without task authorization.

## Existing ADB scripts

Use `ppilot phone wrap ... -- PROGRAM ARGS`, then call `adb` or `ppilot phone adb`. The managed adapter supports shell/exec streams, input, file transfer/sync, package installation/uninstallation, logs/bugreport, forwarding, device status/features, wait/reconnect, emulator-console and device maintenance commands. See `ppilot phone adb --help` for exact options. `-s`, `-t`, `-d` and `-e` can only select the leased device; `-e` means local/TCP transport, including Wi-Fi and emulators.

Android permissions and build capabilities still apply to root/remount/verity/sideload. Do not execute those operations without an appropriate task. Generic commands do not grant permissions or bypass a lock screen on their own. Common tap/swipe/navigation/screenshot commands continue using the managed App/basic action path; extended input retains native ADB semantics.

Forward/reverse mappings use `--no-rebind` and belong to their task. Removal only affects that task's matching mappings. Pausing, stopping or losing the task cleans its mappings; failed cleanup is retained in the desktop's ownership journal for retry. Keep one wrapper task alive for a tool that needs an ongoing port. A one-off `exec forward` cleans the mapping as its task ends.

App sessions retain the phone capsule and pause/stop controls. Explicit `--backend basic` uses desktop controls without a companion; never switch backends to bypass user takeover. Pausing stops the local ADB process and rejects further commands/stdin. It cannot undo completed writes or guarantee termination of a deliberately detached remote process. A tool that opens a native ADB socket or hardcodes its own adb executable bypasses the managed adapter and is not covered merely by `wrap`.

## Host and transport operations

Use `ppilot phone host --params-file host.json`:

```json
{"args":["version"]}
{"args":["server-status"]}
{"args":["host-features"]}
{"args":["mdns","services"]}
{"args":["start-server"]}
{"args":["kill-server"]}
{"args":["reconnect","offline"]}
{"args":["keygen","/absolute/new-key"]}
```

Host changes affect the shared local ADB server; all phone tasks must end first. `kill-server` suspends background polling until explicit `start-server`, so the server stays stopped. Key generation requires a new absolute output path. Remote server selection (`-H`, `-P`, `-L`) and inherited host descriptors are not forwarded across the desktop's ownership boundary. Use `wireless-discover`, `wireless-pair`, `wireless-connect` and `wireless-disconnect` for transport changes; pairing credentials stay in temporary JSON files.
