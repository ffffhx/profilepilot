import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist/main/phone-bin');
mkdirSync(output, { recursive: true });
if (process.platform === 'win32') {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/out:' + path.join(output, 'adb.exe'), path.join(root, 'native/adb-wrapper.cs')], { stdio: 'inherit', windowsHide: true });
} else {
  writeFileSync(path.join(output, 'adb'), `#!/bin/sh
if [ -z "$PROFILEPILOT_PHONE_RUNTIME" ] || [ -z "$PROFILEPILOT_PHONE_CLI" ]; then
  echo '[ppilot phone CLI] Launch this tool with ppilot phone wrap --device ID -- PROGRAM ARGS.' >&2
  exit 1
fi
ELECTRON_RUN_AS_NODE=1 exec "$PROFILEPILOT_PHONE_RUNTIME" "$PROFILEPILOT_PHONE_CLI" phone adb "$@"
`, { mode: 0o755 });
  chmodSync(path.join(output, 'adb'), 0o755);
}
