# ProfilePilot Browser CLI (`ppilot browser`)

Use ProfilePilot Browser CLI (`ppilot browser`) when this route was selected. It sends commands through the independent local browser service to the target Profile's extension, without invoking an additional model. Browser commands automatically start that service; the desktop App can remain closed. Install/connect the extension in the exact target Profile. Do not substitute `ppilot chat` or `ppilot run`, which start model-backed tasks.

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

Use `open URL`, `switch TAB_ID` and `newTab` with the same `--session`. Ordinary inputs do not focus the browser window. Chrome internal pages, discarded tabs and native dialogs have limitations; report failures rather than bringing windows forward to guess an outcome.

`open --params-file navigation.json` accepts `{"url":"https://example.com/?q=AI&sort=new"}`; `switch --params-file tab.json` accepts `{"tabId":123}`. An explicit positional URL or tab ID overrides the corresponding JSON field.

## Debugging and downloads

`debug` enables Runtime/Network/Log/Performance events; `events` takes `{ "since": 0, "limit": 100 }`. Continue from the returned cursor; honor `hasMore` and `dropped`. `cdp METHOD --params-file params.json` exposes the domains Chrome's extension debugger supports, not an unrestricted browser-level CDP server. Use `--cdp-session ID` for child frames; keep the task's `--session` separately.

`history` takes `{ "query": "example", "maxResults": 100 }` and searches the target Profile's history. Query only the scope the task needs.

`download --params-file download.json` accepts an explicit HTTP(S) URL, filename and timeout. Track the returned download ID. After timeout, query/wait for that ID instead of starting another download. Page-triggered blob/data downloads can be ambiguous; do not claim a file is captured unless the returned artifact is registered and verified.

## Control lifecycle

```sh
ppilot browser --session research handoff
ppilot browser --session research resume
ppilot browser --session research observe
ppilot browser --session research complete
```

These illustrate separate stages: stop and wait after handoff; resume only after explicit return. Use `release` for cancellation. Exit 69 means disconnected; exit 75 means takeover, conflict, stale observation or an uncertain timeout. Reconcile the returned `NATIVE_*` code. Do not auto-resume or replay. A repeated `--request-id` retrieves the same request only; never reuse it for different parameters. App restart preserves external CLI sessions. Browser service restart loses direct sessions, so inspect state before a new claim.
