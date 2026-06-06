# ProfilePilot

ProfilePilot is a small Electron desktop app for managing Chrome profiles and extensions on this machine.

The app treats Chrome's own local profiles as first-class profiles:

- Chrome's `Default` / `Profile N` profiles are discovered from Chrome's local `Local State`.
- The default Chrome profile is protected from deletion.
- Extra isolated profiles can still be created for sandboxed test sessions.
- Isolated profiles launch with `--user-data-dir` so each one is separated from Chrome's own default profile store.
- Deleting a deletable profile moves its directory to the trash-style location first.
- The UI shows running profiles by inspecting Chrome processes launched with `--profile-directory` or `--user-data-dir`.
- The renderer talks to native capabilities through an Electron preload bridge.

## Run

```bash
npm install
npm start
```

This compiles the TypeScript sources and opens the Electron app.

## Development

```bash
npm run check
npm run build
```

Source files live in `src/`:

- `src/main/` contains the Electron main process and local profile management logic.
- `src/preload.ts` exposes the safe desktop API to the renderer.
- `src/renderer/app.ts` renders the UI.

## Data Directory

On macOS, managed profile data is stored at:

```text
~/Library/Application Support/ProfilePilot
```

Existing local installs may continue reading the legacy data directory if it already exists:

```text
~/Library/Application Support/Codex Chrome Profile Manager
```

Override it when needed:

```bash
CPM_DATA_DIR=/path/to/data npm start
```

## Chrome Launcher

On macOS, the app launches:

```text
Google Chrome
```

Override the app name:

```bash
CHROME_APP_NAME="Google Chrome Canary" npm start
```

Or use a binary directly:

```bash
CHROME_BINARY=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome npm start
```
