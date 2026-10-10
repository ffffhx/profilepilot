// Real SDK + local scripted model. Verifies storage, prompt loading and tool
// permissions; does not assess a real model's memory selection quality.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startModelFixture } from './task-model-fixture.mjs';
const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-sdk-memory-'));
let service, phase = '', step = 0;
const seen = new Map();
const marker = 'PP_MEMORY_FIXTURE_CEDAR_927';
const editedMarker = 'PP_MEMORY_FIXTURE_MAPLE_614';
let memoryDir, otherDir;
const tool = (name, input) => ({ type: 'tool_use', id: `memory_${phase}_${step}`, name, input });
const model = await startModelFixture(body => {
  if (!body.tools?.some(tool => tool.name === 'mcp__profilepilot__observe')) return { type: 'text', text: 'Auxiliary response' };
  const requests = seen.get(phase) || []; requests.push(body); seen.set(phase, requests); step++;
  if (phase === 'write') {
    if (step === 1) return tool('Write', { file_path: path.join(memoryDir, 'feedback.md'), content: `---\nname: formatting\ndescription: stable format preference\ntype: feedback\n---\n${marker}\nUse concise Chinese responses.\n` });
    if (step === 2) return tool('Write', { file_path: path.join(memoryDir, 'MEMORY.md'), content: `# Memory\n- [Formatting](feedback.md) — ${marker}\n` });
    if (step === 3) return tool('Write', { file_path: path.join(otherDir, 'MEMORY.md'), content: 'CROSS_PROFILE_WRITE_MUST_FAIL' });
    if (step === 4) return tool('Write', { file_path: path.join(root, 'outside.md'), content: 'OUTSIDE_WRITE_MUST_FAIL' });
  }
  if (phase === 'recall' && step === 1) return tool('Read', { file_path: path.join(memoryDir, 'feedback.md') });
  if (phase === 'recall' && step === 2) return tool('Edit', { file_path: path.join(memoryDir, 'feedback.md'), old_string: 'Use concise Chinese responses.', new_string: 'Use short Chinese responses.' });
  return { type: 'text', text: `Memory fixture ${phase} finished.` };
});
const dependencies = { browser: {}, apiKey: () => 'local-fixture-key', profileName: async id => id, changed: () => {}, notify: () => {} };
const waitForTask = async task => {
  const deadline = Date.now() + 60000;
  while (service.runs.has(task.id) || task.status === 'queued') {
    if (Date.now() > deadline) throw new Error(`${phase} timed out: ${task.status}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(task.status, 'partial', JSON.stringify(task.events.filter(event => event.kind === 'error')));
  console.log(`PASS SDK phase: ${phase}`);
  return task;
};
const run = async (next, profileId, mode) => {
  phase = next; step = 0;
  return waitForTask(await service.create({ profileId, mode, prompt: `纯问答：${next} memory fixture。不要操作浏览器或终端。` }));
};
try {
  let store = new TaskStore(root); store.data.settings.baseUrl = model.url;
  service = new TaskService(store, dependencies);
  memoryDir = service.memory.directory('native:A'); otherDir = service.memory.directory('native:B');
  const first = await run('write', 'native:A');
  assert.ok((await readFile(path.join(memoryDir, 'feedback.md'), 'utf8')).includes(marker));
  assert.equal(service.getMemory('native:B').files.length, 0);
  await assert.rejects(readFile(path.join(root, 'outside.md')), { code: 'ENOENT' });
  await service.close();
  store = new TaskStore(root); service = new TaskService(store, dependencies);
  const second = await run('recall', 'native:A');
  assert.notEqual(first.sdkSessionId, second.sdkSessionId, 'new tasks use different SDK sessions');
  assert.ok(JSON.stringify(seen.get('recall')[0]).includes(marker), 'SDK must load MEMORY.md before the model makes a tool call');
  assert.ok(JSON.stringify(seen.get('recall').at(-1)).includes('Use concise Chinese responses.'), 'native Read loads the topic');
  assert.ok((await readFile(path.join(memoryDir, 'feedback.md'), 'utf8')).includes('Use short Chinese responses.'), 'native Edit updates the topic');
  const index = service.getMemory('native:A').files.find(file => file.name === 'MEMORY.md');
  service.writeMemory('native:A', index.name, index.content.replaceAll(marker, editedMarker), index.revision);
  await run('edited', 'native:A');
  assert.ok(JSON.stringify(seen.get('edited')[0]).includes(editedMarker));
  phase = 'resume'; step = 0;
  const session = second.sdkSessionId;
  await service.control(second.id, 'resume', '纯问答：继续检查已更新的偏好，不操作浏览器。');
  await waitForTask(second);
  assert.equal(second.sdkSessionId, session);
  assert.ok(JSON.stringify(seen.get('resume')[0]).includes(editedMarker), 'resumed session refreshes SDK memory context');
  await run('isolated', 'native:B');
  assert.ok(!JSON.stringify(seen.get('isolated')).includes(marker));
  assert.ok(!JSON.stringify(seen.get('isolated')).includes(editedMarker));
  await run('plan', 'native:A', 'plan');
  assert.ok(JSON.stringify(seen.get('plan')[0]).includes(editedMarker));
  assert.ok(!seen.get('plan')[0].tools.some(tool => ['Write', 'Edit'].includes(tool.name)));
  await run('manual', 'native:A', 'manual');
  assert.ok(!seen.get('manual')[0].tools.some(tool => ['Write', 'Edit'].includes(tool.name)));
  service.setMemoryEnabled('native:A', false);
  await run('disabled', 'native:A');
  assert.ok(!JSON.stringify(seen.get('disabled')[0]).includes(editedMarker));
  assert.ok(!seen.get('disabled')[0].tools.some(tool => ['Write', 'Edit'].includes(tool.name)));
  await service.close();
  const output = path.resolve('test-results/browser-tasks/sdk-memory-result.json');
  await mkdir(path.dirname(output), { recursive: true });
  const sdkPackage = JSON.parse(await readFile(path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8'));
  await writeFile(output, JSON.stringify({ passed: true, platform: process.platform, sdk: sdkPackage.version,
    phases: [...seen.keys()], crossTaskRecall: true, profileIsolation: true, directoryEscapeBlocked: true, managementEditsLoaded: true, planReadOnly: true, disabled: true }, null, 2));
} finally {
  await service?.close(); await model.close();
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('pp-sdk-memory-')) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
