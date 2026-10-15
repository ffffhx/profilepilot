import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm run e2e:workspace-recovery` deliberately emits TypeScript again after
// bundling. Browser assets must survive: CommonJS emission once overwrote the
// shell bundle and produced a blank window (`exports is not defined`).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'profilepilot-workspace-recovery-'));
const env = { ...process.env, WORKSPACE_RECOVERY_FIXTURE: fixture };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'scripts/e2e/fixtures/workspace-recovery.cjs')], {
  cwd: root, env, windowsHide: true, stdio: 'inherit'
});
const timer = setTimeout(() => child.kill(), 30000);
child.once('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(timer); console.log(`Workspace recovery evidence: ${fixture}`); process.exitCode = code ?? 1; });
