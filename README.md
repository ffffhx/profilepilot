# Chrome Profile Manager

A small local web tool for managing isolated Chrome profile directories.

It follows the safer "managed profiles" model:

- Profiles live outside Chrome's own default profile store.
- Launching uses `--user-data-dir` so each profile is isolated.
- Deleting a profile moves its directory to the trash-style location first.
- The UI shows running profiles by inspecting Chrome processes that were launched with a managed `--user-data-dir`.

## Run

```bash
npm start
```

Open:

```text
http://127.0.0.1:5177
```

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
