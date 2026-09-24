import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';

// Sequential rounds deliberately reuse browser storage, tabs and Gateway state.
// Each real-model task still has its own session and must release ownership.
const output = path.resolve(process.env.PP_DOGFOOD_OUTPUT || `test-results/profile-reuse-${Date.now()}`);
await mkdir(output, { recursive: true });
const results = [];
const require = createRequire(import.meta.url);
const providerRoot = process.env.PP_TASK_PROVIDER_ROOT || path.join(require('../dist/main/fs-util').defaultDataDir(), 'browser-tasks');
const profileCount = Number(process.env.PP_QA_PROFILE_COUNT || 2);
const scenarios = (process.env.PP_QA_SCENARIOS || 'pagination,tabs,pause-resume').split(',');
for (let profile = 1; profile <= profileCount; profile++) {
  const gateway = await startTaskGatewayFixture();
  try {
    for (const scenario of scenarios) {
      const round = path.join(output, `profile-${profile}`);
      await mkdir(round, { recursive: true });
      const started = Date.now();
      const child = spawn(process.execPath, ['scripts/verify-task-agent-dogfood.mjs', scenario], {
        env: { ...process.env, PP_TASK_PROVIDER_ROOT: providerRoot, PP_DOGFOOD_OUTPUT: round,
          PP_DOGFOOD_GATEWAY: JSON.stringify({ id: gateway.id, port: gateway.port, home: gateway.home }) },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data; process.stdout.write(data); });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      await writeFile(path.join(round, `${scenario}.log`), log);
      results.push({ profile, profileId: gateway.id, port: gateway.port, scenario, code, elapsedMs: Date.now() - started });
      await writeFile(path.join(output, 'summary.json'), JSON.stringify(results, null, 2));
      // Hard stops require investigation, never another session as a bypass.
      if (/AGENT_USER_IN_CONTROL|PROFILE_LEASE_CONFLICT|AGENT_BROWSER_DETACHED_FROM_GATEWAY/.test(log)) break;
    }
  } finally { await gateway.close(); }
}
console.log('REUSE_RESULTS', JSON.stringify({ output, results }));
process.exitCode = results.length === profileCount * scenarios.length && results.every(r => r.code === 0) ? 0 : 1;
