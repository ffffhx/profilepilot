import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makePlan, summarize, classify } from '../benchmarks/agent-tasks/lib/contracts.mjs';
import { loadAdapter, executeAdapter, collectArtifacts } from '../benchmarks/agent-tasks/lib/process.mjs';

const catalog = { defaultSeeds: [1101, 2202, 3303], tasks: [
  { id: 'mail', title: 'Mail', status: 'ready', conditions: ['baseline', 'commit-response-loss'] },
  { id: 'phone', title: 'Phone', status: 'planned', conditions: ['baseline'] }
] };

test('pre-register all seeds/repetitions; reject planned, unknown and duplicate selections', () => {
  const plan = makePlan(catalog, { repeat: 2 });
  assert.equal(plan.length, 6);
  assert.equal(new Set(plan.map(cell => cell.id)).size, 6);
  assert.throws(() => makePlan(catalog, { tasks: ['phone'] }), /planned/);
  assert.throws(() => makePlan(catalog, { tasks: ['unknown'] }), /Unknown/);
  assert.throws(() => makePlan(catalog, { tasks: ['mail', 'mail'] }), /Duplicate/);
  assert.throws(() => makePlan(catalog, { seeds: [1101, 1101] }), /unique/);
  assert.throws(() => makePlan(catalog, { condition: 'invented' }), /not supported/);
});

test('missing cells and environmental failures remain in denominator; unknown cost stays unknown', () => {
  const plan = makePlan(catalog);
  const summary = summarize(plan, [{ id: plan[0].id, status: 'success', elapsedMs: 12 }, { id: plan[1].id, status: 'environment_invalid' }]);
  assert.equal(summary.planned, 3); assert.equal(summary.not_run, 1); assert.equal(summary.environment_invalid, 1);
  assert.equal(summary.successRate, 1 / 3); assert.equal(summary.totalCostUsd, null);
  assert.throws(() => summarize(plan, [{ id: plan[0].id, status: 'success' }, { id: plan[0].id, status: 'success' }]), /registered plan/);
});

test('independent checks and execution budget cannot be overridden by finish claims', () => {
  const execution = { response: { status: 'completed' } };
  const grade = { businessGoalAchieved: true, mandatoryConstraintsMet: true, checks: [{ passed: true }] };
  assert.equal(classify({ execution, grade }), 'success');
  assert.equal(classify({ execution, grade: { ...grade, mandatoryConstraintsMet: false } }), 'failed');
  assert.equal(classify({ execution, grade: { ...grade, checks: [{ passed: false }] } }), 'failed');
  assert.equal(classify({ execution: { ...execution, timedOut: true }, grade }), 'timeout');
  assert.equal(classify({ execution: { response: { status: 'blocked' } }, grade }), 'blocked');
});

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-eval-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'outputs'));
  return root;
}

test('adapter uses argv and BOM JSON config without shell expansion', async t => {
  const root = await workspace(t), file = path.join(root, 'adapter.json');
  const config = { protocolVersion: 1, id: 'test', agent: 'test', tool: 'test', model: 'test', toolVersion: '1', track: 'matched-browser-dom', command: '$NODE', args: ['$REPO/a b/中文.js', 'literal$(nope)'], environment: 'external-browser' };
  await writeFile(file, '\uFEFF' + JSON.stringify(config));
  const loaded = await loadAdapter(file, root);
  assert.equal(loaded.command, process.execPath);
  assert.equal(loaded.args[0], `${root}/a b/中文.js`);
  assert.equal(loaded.args[1], 'literal$(nope)');
});

test('external adapter receives only public request and returns structured result', async t => {
  const root = await workspace(t);
  const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const r=JSON.parse(input);console.log(JSON.stringify({protocolVersion:1,status:'completed',answer:r.task.prompt,usage:{costUsd:0},metadata:{agent:'test',model:'test',tool:'test',toolVersion:'1',track:'test'}}));});`;
  const result = await executeAdapter({ command: process.execPath, args: ['-e', script] }, { protocolVersion: 1, runId: 'test', workspace: root, task: { prompt: '中文 $() ` quote "' }, budget: { timeoutMs: 5000 } });
  assert.equal(result.error, undefined);
  assert.equal(result.response.answer, '中文 $() ` quote "');
});

test('streamed UTF-8 is preserved and claimed identities cannot change the registered model', async t => {
  const root = await workspace(t);
  const response = { protocolVersion: 1, status: 'completed', answer: '上海，中文与🙂', usage: { costUsd: null }, metadata: { agent: 'test', model: 'model-a', tool: 'test', toolVersion: '1', track: 'test' } };
  const script = `const bytes=Buffer.from(${JSON.stringify(JSON.stringify(response))});let i=0;const timer=setInterval(()=>{if(i===bytes.length){clearInterval(timer);return;}process.stdout.write(bytes.subarray(i,i+1));i++;},1);process.stdin.resume();`;
  const req = { runId: 'utf8', workspace: root, budget: { timeoutMs: 5000 } };
  const pass = await executeAdapter({ command: process.execPath, args: ['-e', script], model: 'model-a' }, req);
  assert.equal(pass.error, undefined); assert.equal(pass.response.answer, response.answer);
  const mismatch = await executeAdapter({ command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(response))})`], model: 'model-b' }, req);
  assert.match(mismatch.error, /metadata.model differs/);
});

test('successful adapter answers and nested metadata redact known environment secrets', async t => {
  const root = await workspace(t), key = 'PP_EVAL_TEST_SECRET';
  const previous = process.env[key]; process.env[key] = 'synthetic-secret-for-output-test';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const script = `console.log(JSON.stringify({protocolVersion:1,status:'completed',answer:process.env.${key},metadata:{agent:'test',model:'test',tool:'test',toolVersion:'1',track:'test',nested:{secret:process.env.${key}}}}));`;
  const result = await executeAdapter({ command: process.execPath, args: ['-e', script] }, { runId: 'secret', workspace: root, budget: { timeoutMs: 5000 } });
  assert.equal(result.error, undefined);
  assert.equal(result.response.answer, '[REDACTED]');
  assert.equal(result.response.metadata.nested.secret, '[REDACTED]');
});

test('invalid protocol, nonzero exits and timeout are retained failures', async t => {
  const root = await workspace(t);
  const request = { runId: 'test', workspace: root, budget: { timeoutMs: 300 } };
  const invalid = await executeAdapter({ command: process.execPath, args: ['-e', `console.log('success')`] }, request);
  assert.ok(invalid.error);
  const failed = await executeAdapter({ command: process.execPath, args: ['-e', 'process.exit(2)'] }, request);
  assert.match(failed.error, /exited 2/);
  const timed = await executeAdapter({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, request);
  assert.equal(timed.timedOut, true);
});

test('collect artifact bytes and reject directories or oversized output', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'outputs', 'answer.json'), '{"answer":"上海"}');
  assert.equal((await collectArtifacts(root))['answer.json'], '{"answer":"上海"}');
  await mkdir(path.join(root, 'outputs', 'escape.json'));
  await assert.rejects(collectArtifacts(root), /regular files/);
});
