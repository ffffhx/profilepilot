# ProfilePilot CLI: Profile management

Use the installed ProfilePilot CLI (`ppilot`) against the running ProfilePilot app. `profilepilot` remains a compatibility alias. The older ppilot profile spelling remains compatible. This route manages Profiles; it does not read or click their pages.

```sh
ppilot status --json
ppilot browser profile list --json
ppilot browser profile get "EXACT_PROFILE_ID" --json
ppilot browser profile create --name "Research" --json
ppilot browser profile rename "isolated:ID" "Research 2" --json
ppilot browser profile configure "isolated:ID" --hide-automation on --json
ppilot browser profile start "isolated:ID" --json
ppilot browser profile stop "isolated:ID" --json
```

List before selecting and use exact IDs when names repeat. Mutate only records with `manageable: true`; system and sub Profiles are query-only in this management API. This restriction does not prevent page control through their connected extension.

`configure --hide-automation on|off` saves a per-Profile Chromium `AutomationControlled` override for the next launch. It affects `navigator.webdriver`, not Gateway ownership or Agent access, and does not guarantee CAPTCHA clearance. Inspect `hide_automation` with `profile get`; restart a running Profile only within the user's authorized task and after checking occupancy and unsaved work.

Deletion needs authorization for the specific Profile and `ppilot browser profile delete "isolated:ID" --yes --json`. A request to stop or finish a browser task is not deletion authorization. Do not edit registry JSON or move Profile directories manually.

`PROFILEPILOT_APP_NOT_RUNNING` means restore the app and retry status. `PROFILE_NAME_AMBIGUOUS` means list and select an ID. `PROFILE_CLI_MANAGED_ONLY` means the Profile is query-only. Preserve occupied Profiles; do not steal an Agent session. Ending a browser session and stopping its Profile are separate operations.
