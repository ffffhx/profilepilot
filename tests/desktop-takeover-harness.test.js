const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { Script, createContext } = require('node:vm');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const crypto = require('node:crypto');

const entry = path.resolve(__dirname, '../scripts/verify-desktop-takeover.mjs');
const source = readFileSync(entry, 'utf8').replace(/^import .*;\r?$/gm, '').replaceAll('import.meta.url', 'fixtureModuleUrl');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));

// Execute the actual harness with in-memory files and an injected CLI. This
// never imports Electron, launches a process, enumerates windows or sends input.
async function runHarness(scenario = 'success', args = ['--run', '--assisted-foreground']) {
  const files = new Map(), calls = [], actions = [], output = [];
  let directory, fileBase, nonce, foreignMarker, owner = null, generation = 'g1', receipt, version = 0, launched = 0, stopped = 0, resumes = 0, foreignRequests = 0;
  const target = { id: 'owned-window', pid: 123, nativeHandle: '999', title: 'ProfilePilot takeover verification' };
  const environment = { pid: 123, hwnd: '999', startedUtcTicks: '638970000000000000', administrator: false, pointerBits: 64, hooksInstalled: false };
  const historical = new Map();
  function status() {
    return { available: true, session: owner && { name: owner.name, window: target, state: owner.state },
      inputObservation: { available: true, phase: !owner ? 'idle' : owner.state === 'paused' ? 'paused' : 'ready',
        ...(owner ? { generation, epoch: 'epoch' } : {}),
        ...(owner?.state === 'paused' ? { reason: scenario === 'unexpected_takeover' ? 'physical_input' : 'external_input', certainty: 'observed' } : {}) } };
  }
  const process = { platform: 'win32', argv: ['node', entry, ...args], env: {}, exitCode: 0 };
  const context = createContext({
    assert, path, fileURLToPath, fixtureModuleUrl: pathToFileURL(entry).href,
    os: { tmpdir: () => path.join(root, '.tools', 'mock-takeover') }, process,
    createHash: crypto.createHash, randomBytes: crypto.randomBytes, randomUUID: crypto.randomUUID,
    console: { log: value => output.push(JSON.parse(value)) },
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearInterval() {},
    setInterval: () => ({ unref() {} }),
    assertDesktopAcceptanceWindow: async () => calls.push('gate'),
    execFileSync: () => { calls.push('compile'); return ''; }, assistedFixtureSource: 'mock-assisted.cs',
    compileAssistedPreparer: () => { calls.push('compile-assisted'); return 'mock.exe'; },
    prepareAssistedForeground: async () => { calls.push('assisted'); return { ok: true }; },
    mkdir: async () => {},
    mkdtemp: async prefix => { directory = prefix + 'pure'; return directory; },
    writeFile: async (file, content) => files.set(file, String(content)),
    readFile: async file => {
      if (file === path.join(root, 'scripts/e2e/desktop-takeover-fixture.cs')) return Buffer.from('pure fixture source hash');
      if (file === fileBase + '.environment.json') return JSON.stringify({ ...environment, nonce, marker: foreignMarker });
      if (file === fileBase + '.input.json') return JSON.stringify(receipt);
      if (file === fileBase + '.closed.json') return JSON.stringify({ pid: 123, nonce });
      if (!files.has(file)) throw Object.assign(new Error('Missing in-memory file'), { code: 'ENOENT' });
      return files.get(file);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from)); files.delete(from);
      if (!to.endsWith('.foreign.request.json')) return;
      foreignRequests++;
      const request = JSON.parse(files.get(to)); assert.equal(request.nonce, nonce); assert.equal(request.pid, 123);
      receipt.foreign = { ...receipt.foreign, requested: true, attempted: true, complete: scenario !== 'unknown_receipt',
        inserted: scenario === 'unknown_receipt' ? 1 : 2, down: 1, up: scenario === 'unknown_receipt' ? 0 : 1,
        released: scenario !== 'unknown_receipt', nonForeground: 0, unmatched: 0,
        error: scenario === 'unknown_receipt' ? 'TAKEOVER_RECEIPT_UNKNOWN_NO_RETRY' : null,
        preflight: { heldCount: 0, ownedFocus: true, ownedForeground: true } };
      receipt.sequence += 2; receipt.markerEvidence.counts.push({ marker: '000000008901def0', down: 1, up: 1 });
      owner.state = 'paused';
    },
    launchWindowsUserProcess: async (_exe, parameters) => {
      launched++; [fileBase, nonce, foreignMarker] = parameters;
      receipt = { nonce, pid: 123, sequence: 0, text: '', textChanges: 0, editFocused: true, targetWasForeground: true,
        markerEvidence: { counts: [], overflow: false }, foreign: { attempted: false, requested: false, error: null, down: 0, up: 0 } };
      return { pid: 123 };
    },
    terminateOwnedWindowsProcess: (pid, executable) => {
      assert.equal(pid, 123); assert.equal(path.dirname(executable), directory); stopped++;
      if (scenario === 'cleanup_failure') throw new Error('Owned process stop was not confirmed');
    },
    runDesktopCliProcess: async ({ args: parameters, expectedExitCode }) => {
      const name = parameters[0] === 'desktop' ? parameters[1] : 'runtime-status';
      calls.push(name);
      let response, exitCode = 0;
      const flag = name => parameters[parameters.indexOf(name) + 1];
      if (name === 'runtime-status') response = { ok: true, data: { pid: 456, build: { entry: path.join(root, 'dist/main/entry.js'), buildId: 'mock-build', startedAt: 'mock-start' } } };
      else if (name === 'status') {
        if (scenario === 'status_failure' && foreignRequests) throw Object.assign(new Error('Status unavailable'), { code: 'DESKTOP_CLI_TIMEOUT', outcome: 'unknown' });
        response = { ok: true, result: status() };
      } else if (name === 'windows') response = { ok: true, result: { windows: [target] } };
      else if (name === 'claim') { owner = { name: flag('--session'), state: 'active' }; response = { ok: true, result: status() }; }
      else if (name === 'observe') response = { ok: true, result: { version: 'v' + ++version, elements: [{ name: 'Takeover owned edit', role: 'Edit', reference: 'e1', actions: ['focus', 'set_value'] }] } };
      else if (name === 'doctor') response = { ok: true, result: { source: { integrity: { rid: 8192, elevated: false } }, target: { pid: 123, integrity: { rid: 8192, elevated: false } }, foreground: { hwnd: '999' } } };
      else if (name === 'receipt') response = { ok: true, result: historical.get(flag('--request-id')) };
      else if (name === 'resume') { resumes++; owner.state = 'active'; generation = 'g2'; response = { ok: true, result: status() }; }
      else if (name === 'release') { owner = null; response = { ok: true, result: status() }; }
      else if (name === 'complete') {
        assert.equal(parameters.includes('--require-active'), true); assert.equal(owner.state, 'paused');
        if (scenario === 'completion_lost_takeover') { owner = null; response = { ok: true, result: status() }; }
        else { exitCode = 75; response = { ok: false, code: 'DESKTOP_USER_IN_CONTROL' }; }
      }
      else if (name === 'action') {
        const params = JSON.parse(files.get(flag('--params-file'))); actions.push(params);
        if (owner.state === 'paused') { exitCode = 75; response = { ok: false, code: 'DESKTOP_USER_IN_CONTROL' }; }
        else {
          if (params.kind === 'type_text') {
            receipt.text += params.value; receipt.sequence++; receipt.textChanges++;
            receipt.markerEvidence.counts.push({ marker: generation === 'g1' ? '0000000012345678' : '0000000023456789', down: params.value.length, up: params.value.length });
          }
          response = { ok: true, result: { executed: true } };
          historical.set(flag('--request-id'), { state: 'succeeded', historical: true, requestId: flag('--request-id'), result: response.result });
        }
      } else throw new Error('Unexpected CLI: ' + parameters.join(' '));
      if (expectedExitCode !== null) assert.equal(exitCode, expectedExitCode);
      return { exitCode, response: clone(response) };
    }
  });
  await new Script('(async () => {\n' + source + '\n})()', { filename: entry }).runInContext(context);
  const reportEntry = [...files].find(([file]) => file.endsWith('report.json'));
  return { calls, actions, launched, stopped, resumes, foreignRequests, output, exitCode: process.exitCode, report: reportEntry && JSON.parse(reportEntry[1]) };
}

test('default takeover harness only compiles and never queries App, launches GUI or injects input', async () => {
  const value = await runHarness('success', []);
  assert.deepEqual(value.calls, ['compile']); assert.equal(value.launched, 0); assert.equal(value.foreignRequests, 0);
  assert.equal(value.output[0].mode, 'compile-only'); assert.equal(value.output[0].guiStarted, false);
});
test('actual harness mock proves distinct own input, foreign pause, rejected UIA, read-only receipt and explicit new-generation resume', async () => {
  const value = await runHarness();
  assert.equal(value.report.ok, true); assert.equal(value.report.checks.length, 5); assert.equal(value.exitCode, 0);
  assert.equal(value.foreignRequests, 1); assert.equal(value.resumes, 1); assert.equal(value.stopped, 1);
  assert.deepEqual(value.actions.map(action => action.kind), ['focus', 'type_text', 'set_value', 'type_text']);
  assert.equal(value.report.cleanup.session, null); assert.equal(value.report.cleanup.fixtureStopped, true);
  assert.equal(value.report.hardwareInputTested, false); assert.equal(value.report.additionalHooksInstalled, false);
});
for (const scenario of ['unknown_receipt', 'unexpected_takeover', 'status_failure', 'completion_lost_takeover']) test('harness stops without resume/input retry and independently cleans its fixture: ' + scenario, async () => {
  const value = await runHarness(scenario);
  assert.equal(value.report.ok, false); assert.equal(value.exitCode, 1); assert.equal(value.foreignRequests, 1);
  assert.equal(value.resumes, 0); assert.equal(value.actions.filter(action => action.kind === 'type_text').length, 1);
  assert.equal(value.stopped, 1); assert.equal(value.calls.includes('release'), true); assert.equal(value.report.cleanup.fixtureStopped, true);
  if (scenario === 'status_failure') assert.ok(value.report.cleanup.sessionError);
});
test('cleanup failure makes an otherwise successful takeover report fail with nonzero exit', async () => {
  const value = await runHarness('cleanup_failure');
  assert.equal(value.report.checks.length, 5); assert.equal(value.report.ok, false); assert.equal(value.exitCode, 1);
  assert.match(value.report.cleanup.fixtureError, /not confirmed/); assert.equal(value.report.cleanup.session, null);
});
