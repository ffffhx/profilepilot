# Chrome Profile Manager

A small Electron desktop app for managing isolated Chrome profile directories.

It follows the safer "managed profiles" model:

- Profiles live outside Chrome's own default profile store.
- Launching uses `--user-data-dir` so each profile is isolated.
- Deleting a profile moves its directory to the trash-style location first.
- The UI shows running profiles by inspecting Chrome processes that were launched with a managed `--user-data-dir`.
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
