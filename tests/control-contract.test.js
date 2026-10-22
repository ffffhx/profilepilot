const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { normalizeCommonInput } = loadCli('src/main/browser-engine/common-input.ts');
const { writeControlTrace } = loadCli('src/main/control-trace.ts');
const { controlRecovery } = loadCli('src/shared/control-recovery.ts');

test('common JSON handles BOM, Chinese, spaces and literal shell text without interpretation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp 合约 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const action = { kind: 'fill', version: 'observed', ref: '@e123', value: '中文 "$()" `命令` \\ 路径\n第二行' };
  fs.writeFileSync(path.join(root, '动作.json'), '\uFEFF' + JSON.stringify(action));
  const args = normalizeCommonInput(['action', '--params-file', '动作.json'], root);
  assert.deepEqual(JSON.parse(args[2]), action);
  assert.deepEqual(JSON.parse(normalizeCommonInput(['action', '--params-stdin'], root, () => JSON.stringify(action))[2]), action);
  assert.equal(normalizeCommonInput(['observe', '--output', '图 片.png'], root)[4], path.join(root, '图 片.png'));
  for (const bad of [[], { kind: 'click', version: null, ref: 'e1' }, { ...action, ref: '#unsafe' }, { kind: 'upload', version: 'one', ref: 'e1', files: [] }]) {
    assert.throws(() => normalizeCommonInput(['action', '--params', JSON.stringify(bad)]), { code: 'BROWSER_INVALID_ARGUMENTS' });
  }
  assert.throws(() => normalizeCommonInput(['action', '--params', '{}', '--params-stdin']), { code: 'BROWSER_INVALID_ARGUMENTS' });
  assert.equal(controlRecovery('BROWSER_STALE_REF').nextStep, 'reobserve');
});

test('control traces correlate requests, omit arbitrary input and rotate bounded files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const event = { requestId: '12345678-1234-1234-1234-123456789abc', sessionId: 'private task title', target: 'private account',
    method: 'action', durationMs: 12, generation: 3, params: { password: 'SENSITIVE' }, message: 'secret text',
    recovery: { ...controlRecovery('NATIVE_DISCONNECTED'), instruction: 'secret text' } };
  for (let i = 0; i < 5; i++) writeControlTrace(root, 'extension', event, 1);
  const files = fs.readdirSync(path.join(root, 'control-diagnostics'));
  assert.equal(files.length, 2);
  const raw = fs.readFileSync(path.join(root, 'control-diagnostics', files.find(f => f.endsWith('.jsonl'))), 'utf8');
  assert.doesNotMatch(raw, /SENSITIVE|secret text|private task|private account|password/);
  const row = JSON.parse(raw); assert.equal(row.requestId, event.requestId); assert.equal(row.actionOutcome, 'unknown');
  assert.equal(row.automaticReplay, false); assert.equal(row.generation, 3);
});
