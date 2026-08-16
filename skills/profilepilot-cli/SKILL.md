---
name: profilepilot-cli
description: Manage local ProfilePilot Chrome Profiles with the official profilepilot CLI. Use whenever the user asks an Agent to list, inspect, create, rename, start, stop, or delete ProfilePilot Profiles, or to check whether ProfilePilot is running. Prefer this CLI over editing ProfilePilot registry files or automating the desktop UI.
compatibility: Requires the ProfilePilot desktop app and its Profile Management CLI integration.
---

# ProfilePilot management CLI

Use the official local CLI to manage Profiles through the running ProfilePilot app. The CLI talks to ProfilePilot over an authenticated local socket, so it preserves the same validation, launch locks, graceful shutdown, and recoverable deletion behavior as the desktop UI.

## Operating rules

- Start with a read-only query and use `--json` so Profile IDs and state are unambiguous.
- Select by exact Profile ID after listing when names are duplicated.
- Modify only entries where `manageable` is `true`. System Chrome Profiles and sub Profiles are query-only in the management CLI.
- Do not edit `profiles.json`, rename Profile directories, or invoke ProfileManager internals directly.
- Do not use browser-driver `profilepilot close` as a substitute for management commands: that command releases an Agent browser session, while `profilepilot profile stop` manages the Profile itself.
- Treat a nonzero exit status and the returned error code as authoritative. Do not retry destructive or conflicting operations automatically.

## Read and select

Check that the desktop app is reachable:

```bash
profilepilot status --json
```

List Profiles before selecting one:

```bash
profilepilot profile list --json
```

Inspect one Profile by exact name or ID:

```bash
profilepilot profile get "朋友试用" --json
```

## Create and update

Create an independent Profile:

```bash
profilepilot profile create --name "PPE 验证" --json
```

Use the returned ID for later mutations. Rename it with:

```bash
profilepilot profile rename "isolated:PROFILE_ID" "PPE 回归" --json
```

Start or stop the Profile:

```bash
profilepilot profile start "isolated:PROFILE_ID" --json
profilepilot profile stop "isolated:PROFILE_ID" --json
```

These commands are idempotent: starting an already running Profile or stopping an already stopped Profile succeeds with `changed: false`.

## Delete safely

Deletion closes a running independent Profile and moves its data to the system Trash when recovery is available. Because deletion is destructive, obtain explicit user approval for the exact Profile, then pass `--yes`:

```bash
profilepilot profile delete "isolated:PROFILE_ID" --yes --json
```

Without `--yes`, the server refuses the operation. Never infer deletion approval from a request to stop, close, rename, clean up, or finish using a Profile.

## Failure handling

- `PROFILEPILOT_APP_NOT_RUNNING`: ask the user to start ProfilePilot, then retry the read-only status check.
- `PROFILE_NAME_AMBIGUOUS`: list Profiles and select the intended exact ID.
- `PROFILE_CLI_MANAGED_ONLY`: the target is a system or sub Profile; explain that it is query-only.
- `PROFILE_DELETE_CONFIRMATION_REQUIRED`: ask for explicit deletion approval; do not add `--yes` on your own.
- Running or occupancy conflicts: report the current state and wait for user direction rather than taking over another Agent session.
