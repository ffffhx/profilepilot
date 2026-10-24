# ProfilePilot Browser CLI (`ppilot browser`)

For supported website search, details, comments and transcripts, see
[structured website reads](site-adapters.md). Use `ppilot browser sites` to
discover capabilities, then `site --params-file` in the same owned session.

Use ProfilePilot Browser CLI (`ppilot browser`) when this route was selected. Page reads and actions send commands through the independent local browser service to the target Profile's extension, without invoking an additional model. Browser commands automatically start that service; the desktop App can remain closed. Install/connect the extension in the exact target Profile. Do not substitute `ppilot chat` or `ppilot run`, which start model-backed tasks.

`ppilot browser connect --profile native:PROFILE_DIRECTORY` returns an installation/connection URL; open it in that exact Chrome Profile. `pair --profile native:PROFILE_DIRECTORY` returns a manual pairing code to paste into the extension. Do not print pairing codes into task logs or model-visible summaries. `service status` checks the service without launching it; `service start` starts it explicitly. `service stop` refuses while browser sessions still own Profiles. Never stop the shared service merely because one Agent finishes.

```sh
ppilot browser --help
ppilot browser status
ppilot browser --profile native:Default tabs
ppilot browser --profile native:Default --session research claim --tab 123
ppilot browser --session research observe
```

Replace `native:Default` and `123` with actual status/tabs results. Choose a unique session name and reuse it. Claim an explicit existing tab when known; `--new-tab` requests a new page. `connected: true` alone does not guarantee compatibility: a claim requires extension 0.2.0+ with current capabilities. For `NATIVE_EXTENSION_UPDATE_REQUIRED`, update/reload the extension, preserving pairing.

## Observe and act

`observe` returns DOM, element refs and a `version`. Internal guards remain in the independent browser service; the CLI returns public page data and usable refs with the same action/version contract. Use those returned values, then observe again after each action. Save JSON to a UTF-8 file (with or without BOM) on either Windows or macOS:

Each `fast.candidates[].semantics` retains known effects, Enter effects, search/menu/toggle/download flags and command names so callers can distinguish controls with ambiguous labels. Exact links and pagination metadata remain available.

```json
{"kind":"fill","ref":"e1","value":"hello","version":"VERSION_FROM_OBSERVE"}
```

```sh
ppilot browser --session research action --params-file action.json
ppilot browser --session research observe
ppilot browser --session research screenshot --output page.png
```

On Windows PowerShell 5.1/7, use `ppilot` (the installed `ppilot.ps1` entry takes precedence) or `ppilot.ps1`. This preserves `&` in URLs and uses UTF-8 for piped text within that invocation. Check `(Get-Command ppilot).Source` if routing is unclear. Explicit `ppilot.cmd` calls still pass through cmd parsing: use `--params-file` for complex inputs. When bypassing `.ps1`, PowerShell 5.1's default native pipe encoding can turn Chinese text into `?`; prefer a UTF-8 file, or set `$OutputEncoding = [Text.UTF8Encoding]::new($false)` locally before `--params-stdin`.

`read --params-file read.json` supports `frameId`, `cursor`, `query`, `limit` and `textLimit` for frames, Shadow DOM and long pages. Use returned frames and pagination cursors. `pointer` needs a screenshot observation (`observe --params-file` with `{"screenshot":true}`), its version and viewport coordinates.

`observe --output page.png` requests a fresh screenshot and saves it locally while returning refreshed DOM/refs, `version`, `viewport`, absolute `screenshotPath` and `availability`, without base64 in stdout. Open that path with your host's image-viewing tool before reasoning about visual content. Check DOM, screenshot and coordinate availability separately: a dynamic image is usable for inspection but `pointer` requires `availability.coordinates.status === "available"`. A separate `screenshot` does not bind a pointer observation. If capture fails, the failure can carry `partialResult` with fresh DOM; no image path is returned and an existing output file must not be reused. For CAPTCHA puzzles, follow [the current-conversation workflow](captcha.md).

`capabilities` / `schema` describe the common observe/action input contract; they do not prove the target is connected. For explicit local file selection use `action` JSON with `{"kind":"upload","ref":"e2","files":["ABSOLUTE_PATH"],"version":"FROM_OBSERVE"}`. Reobserve to check the selected file before any separately authorized submission.

Run `ppilot browser --profile PROFILE_ID doctor` for live extension/service/CLI versions, capabilities, ownership and installation mode. `status.sessions` includes controller, task title, activity and pending requests; idle time does not authorize stealing a session. `--controller NAME --task TEXT` labels a claim. `wait-control --timeout 30000` waits for release without claiming or resuming. Failure `recovery` reports cause, stage, actionOutcome and nextStep; `unknown` execution requires reconciliation. Bounded diagnostic logs record request correlation and hashed session/target identities, never input values or page text; doctor returns their directory.

Use `open URL`, `switch TAB_ID` and `newTab` with the same `--session`. Ordinary inputs do not focus the browser window. Chrome internal pages, discarded tabs and native dialogs have limitations; report failures rather than bringing windows forward to guess an outcome.

`open --params-file navigation.json` accepts `{"url":"https://example.com/?q=AI&sort=new"}`; `switch --params-file tab.json` accepts `{"tabId":123}`. An explicit positional URL or tab ID overrides the corresponding JSON field.

## Debugging and downloads

`debug` enables Runtime/Network/Log/Performance events; `events` takes `{ "since": 0, "limit": 100 }`. Continue from the returned cursor; honor `hasMore` and `dropped`. `cdp METHOD --params-file params.json` exposes the domains Chrome's extension debugger supports, not an unrestricted browser-level CDP server. Use `--cdp-session ID` for child frames; keep the task's `--session` separately.

`history` takes `{ "query": "example", "maxResults": 100 }` and searches the target Profile's history. Query only the scope the task needs.

`download --params-file download.json` accepts an explicit HTTP(S) URL, filename and timeout. Track the returned download ID. After timeout, query/wait for that ID instead of starting another download. Page-triggered blob/data downloads can be ambiguous; do not claim a file is captured unless the returned artifact is registered and verified.

## Extension UI companion (0.2.13+)

When the user authorizes interaction with a password-manager overlay, use the
current task's `extension-ui` mode. It connects the local browser service to the
same Chrome through browser-level CDP, with the paired extension retaining task
ownership and supplying the exact tab/target mapping. It uses no desktop input.
Do not activate this route silently for ordinary page tasks or after takeover.

```sh
ppilot browser --session TASK extension-ui connect --params-file extension.json
ppilot browser --session TASK extension-ui status
ppilot browser --session TASK extension-ui observe
ppilot browser --session TASK extension-ui click --params-file button.json
ppilot browser --session TASK extension-ui disconnect
ppilot browser --session TASK observe
```

`extension.json` contains `{"extensionId":"TARGET_EXTENSION_ID"}`; obtain the
actual ID from the installed target extension. Chrome remote debugging must be
enabled in `chrome://inspect/#remote-debugging`. `connect` returns `authorizing`
immediately. Ask the user to accept Chrome's connection dialog while this request
is alive; poll `status` until `ready` or `failed`. The service keeps the connection
across commands, so authorization is not requested for every read or click.
After `failed`, inspect the cause and disconnect before an explicit new attempt.

`observe` returns visible button/link labels within the selected extension's
frames embedded in the authorized tab. `button.json` contains the returned
`{"version":"...","ref":"x1"}`. Every click consumes that observation; inspect
the resulting UI or page before another click. Password fields are not exposed.
Choose the correct account from observed labels; a click acknowledgment does not
prove login succeeded. This mode does not unlock a vault, supply biometrics, or
approve an OS passkey dialog. Browser toolbar popups and extension workers are
outside its scope. Normal page commands remain blocked until `disconnect`.

Handoff, completion, release, loss of ownership, extension disconnection or
Chrome CDP disconnection stop the companion. Resume never silently reconnects
it. Do not open a second CDP connection to bypass these controls.

## Control lifecycle

```sh
ppilot browser --session research handoff
ppilot browser --session research resume
ppilot browser --session research observe
ppilot browser --session research complete
```

These illustrate separate stages: stop and wait after handoff; resume only after explicit return. Use `release` for cancellation. Exit 69 means disconnected; exit 75 means takeover, conflict, stale observation or an uncertain timeout. Reconcile the returned `NATIVE_*` code. Do not auto-resume or replay. A repeated `--request-id` retrieves the same request only; never reuse it for different parameters. App restart preserves external CLI sessions. Browser service restart loses direct sessions, so inspect state before a new claim.
