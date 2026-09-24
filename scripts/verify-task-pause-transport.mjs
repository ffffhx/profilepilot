import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
import { startTaskFixture } from './browser-task-fixture.mjs';
const require = createRequire(import.meta.url);
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const output = path.resolve(process.env.PP_DOGFOOD_OUTPUT || `test-results/pause-transport-${Date.now()}`);
await mkdir(output, { recursive: true });
const fixture = await startTaskFixture();
const gateway = await startTaskGatewayFixture();
const browser = new WrapperBrowser(output), results = [];
let task;
try {
  for (let round = 0; round < 10; round++) {
    task = { id: randomUUID(), sessionId: `pp-pause-${randomUUID()}`, profileId: gateway.id, port: gateway.port };
    const opening = browser.execute(task, { kind: 'open', effect: 'read', value: `${fixture.url}/apply`, summary: 'Open owned fixture' }).then(() => 'opened', e => String(e));
    await new Promise(r => setTimeout(r, 200 + round % 3 * 150));
    await browser.control(task, 'handoff');
    const interrupted = await opening;
    await browser.control(task, 'resume');
    const observation = await browser.observeFast(task);
    assert.ok(observation.url);
    await browser.control(task, 'complete');
    results.push({ round, interrupted, url: observation.url });
    console.log('PASS interrupted transport', round);
  }
} catch (error) {
  results.push({ error: String(error) }); console.error(String(error)); process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  if (task) await browser.control(task, 'release').catch(() => {});
  await gateway.close(); await fixture.close();
}
