import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startTaskGatewayFixture } from './task-gateway-fixture.mjs';
import { startTaskFixture } from './browser-task-fixture.mjs';
const require = createRequire(import.meta.url);
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const gateway = await startTaskGatewayFixture();
const fixture = await startTaskFixture();
const task = { id: randomUUID(), sessionId: `pp-viewport-${randomUUID()}`, port: gateway.port, attachments: [] };
const browser = new WrapperBrowser(path.resolve('test-results/browser-tasks'));
try {
  await browser.execute(task, { kind: 'open', value: fixture.url + '/wide', effect: 'read', summary: 'Open viewport fixture' });
  task.observation = await browser.observeFast(task);
  assert.ok(task.observation.viewport.scrollWidth > task.observation.viewport.width);
  const target = task.observation.fast.candidates.find(c => c.label === '个人中心' && c.role === 'button');
  assert.ok(target?.offscreen, 'image-only button outside viewport must retain a named target');
  await browser.execute(task, { kind: 'scroll', value: 'right', effect: 'read', summary: 'Reveal right edge' });
  task.observation = await browser.observeFast(task);
  assert.ok(task.observation.viewport.x > 0);
  await browser.execute(task, { kind: 'click', ref: target.ref, effect: 'read', summary: 'Open account' });
  task.observation = await browser.observeFast(task);
  assert.match(task.observation.snapshot, /个人中心已打开/);
  console.log('PASS real viewport: horizontal overflow, image-only account reference, right scroll and native click');
} finally {
  await browser.control(task, 'complete').catch(() => {});
  await fixture.close(); await gateway.close();
}
