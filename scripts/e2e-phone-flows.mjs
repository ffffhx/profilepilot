import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Uses the real desktop management service, CLI, companion transport and native UI.
// Native ADB is used only to open/reset our debug fixture on a disposable emulator.
const serial = process.argv[2];
if (!/^emulator-\d+$/.test(serial || '')) throw Error('Supply a disposable emulator serial; physical phones are refused.');
const output = path.resolve(process.argv[3] || 'artifacts/phone-flow-regression');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const cli = path.resolve('dist/main/profilepilot-cli.cjs');
await mkdir(output, { recursive: true });
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { child.kill(); reject(Error('Flow test command timed out')); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const phone = (...args) => run(process.execPath, [cli, 'phone', ...args]);
async function device() {
  const result = await phone('list'); assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data.devices.find(value => value.id === serial);
}
async function reset() {
  const result = await run(adb, ['-s', serial, 'shell', 'am', 'start', '-W', '-f', '0x24000000', '-n',
    'io.github.profilepilot.phone/.ControlBenchmarkActivity', '--ez', 'bench_reset', 'true']);
  assert.equal(result.code, 0, result.stderr);
}
async function flowFile(name, steps) {
  const file = path.join(output, name + '.json');
  await writeFile(file, '\ufeff' + JSON.stringify({ version: 1, name, steps }, null, 2)); return file;
}
function launch(file) {
  return phone('run', '--device', serial, '--file', file, '--controller', 'PhoneFlowRegression', '--output-dir', output);
}
function report(result, ok) {
  assert.equal(result.code, ok ? 0 : 1, result.stderr || result.stdout);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.ok, ok, JSON.stringify(data)); return data;
}
async function awaitDevice(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await device(); if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Timed out waiting for phone session state');
}
const current = await device();
assert.equal(current?.companion, 'ready', 'Pair the disposable emulator and enable its test permissions before this regression');
assert.ok(['idle', 'stopped', 'disconnected'].includes(current.state?.phase), 'Do not take over an existing session');
const results = [];
await reset();
const success = report(await launch(path.resolve('scripts/e2e/fixtures/phone-developer-flow.json')), true);
assert.equal(success.steps.length, 26); results.push({ case: 'developer-workflow', ...success });
assert.equal((await device()).state.phase, 'stopped');

await reset();
const menu = { resourceId: 'io.github.profilepilot.phone:id/bench_open_form' };
const failure = report(await launch(await flowFile('断言失败 stops input', [
  { kind: 'wait', selector: menu },
  { kind: 'assert', selector: { text: 'Not present in synthetic fixture' } },
  { kind: 'click', selector: menu }
])), false);
assert.equal(failure.failedStep, 2); assert.equal(failure.steps.length, 2);
const shot = await readFile(path.join(failure.outputDir, 'failure.png'));
assert.equal(shot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
const snapshot = JSON.parse(await readFile(path.join(failure.outputDir, 'failure-snapshot.json'), 'utf8'));
assert.ok(snapshot.nodes.some(node => node.resourceId === menu.resourceId));
results.push({ case: 'assertion-and-evidence', ...failure });

const ambiguous = report(await launch(await flowFile('ambiguous target', [
  { kind: 'click', selector: { className: 'android.widget.Button' } },
  { kind: 'click', selector: menu }
])), false);
assert.equal(ambiguous.steps.length, 1); assert.match(ambiguous.error, /多个控件/);
results.push({ case: 'ambiguous-target', ...ambiguous });

const pauseFile = await flowFile('pause stops flow', [
  { kind: 'wait', selector: { text: 'Waiting for a deliberately absent test control' }, timeoutMs: 30000 },
  { kind: 'click', selector: menu }
]);
const pending = launch(pauseFile);
await awaitDevice(value => value?.state?.controller === 'PhoneFlowRegression' && value.state.task === 'pause stops flow' && ['viewing', 'controlling', 'executing'].includes(value.state.phase));
const paused = await phone('pause', '--device', serial); assert.equal(paused.code, 0, paused.stderr || paused.stdout);
const stopped = report(await pending, false);
assert.equal(stopped.steps.length, 1); assert.ok(stopped.evidenceError);
assert.deepEqual(await readdir(stopped.outputDir), ['report.json']);
await awaitDevice(value => value?.state?.phase === 'stopped');
results.push({ case: 'pause-stops-input-and-evidence', ...stopped });
await writeFile(path.join(output, 'flows-result.json'), JSON.stringify({ passed: 4, results }, null, 2));
console.log('Passed 4 real phone-flow regressions: 26-step developer workflow, failed assertion evidence, ambiguous selector and pause.');
