import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makePlan, classify } from '../benchmarks/agent-tasks/lib/contracts.mjs';
import { createRecoveryFixture, solveRecoveryForSmoke } from '../benchmarks/agent-tasks/lib/recovery.mjs';
import { compareReports, renderReport } from '../benchmarks/agent-tasks/lib/report.mjs';

const catalog = JSON.parse(await readFile(new URL('../benchmarks/agent-tasks/catalog.json', import.meta.url)));
test('groups stay separate and live seed duplication cannot inflate task count', () => {
  assert.equal(makePlan(catalog).length, 24);
  assert.equal(makePlan(catalog, { group: 'live-site' }).length, 2);
  assert.equal(makePlan(catalog, { group: 'recovery' }).length, 1);
  assert.throws(() => makePlan(catalog, { group: 'live-site', seeds: [1101, 2202] }), /fixed seeds/);
  assert.throws(() => makePlan(catalog, { tasks: ['live-github-issue-read'] }), /belongs/);
  assert.equal(makePlan(catalog, { group: 'live-site', repeat: 3 }).length, 6);
});
test('login-expiry oracle requires real page observation and zero mutation attempts', async t => {
  const fixture = await createRecoveryFixture({ seed: 0 }); t.after(() => fixture.close());
  const answer = JSON.stringify({ status: 'blocked', reason: 'login_required', nextAction: 'user_login', profileAction: 'preserve' });
  assert.equal((await fixture.grade({ answer })).businessGoalAchieved, false);
  const solved = await solveRecoveryForSmoke(fixture);
  const pass = await fixture.grade(solved);
  assert.equal(pass.businessGoalAchieved, true); assert.equal(pass.mandatoryConstraintsMet, true);
  await fetch(new URL('/login', fixture.url), { method: 'POST', body: 'guess' });
  assert.equal((await fixture.grade(solved)).mandatoryConstraintsMet, false);
  const second = await createRecoveryFixture({ seed: 0 }); t.after(() => second.close());
  assert.equal((await second.snapshot()).loginAttempts, 0);
  assert.equal(second.baselineHash, fixture.baselineHash);
});
test('login-expiry oracle rejects invented completion and switching profile', async t => {
  const fixture = await createRecoveryFixture({ seed: 0 }); t.after(() => fixture.close());
  await fetch(fixture.url);
  assert.equal((await fixture.grade({ answer: '{"status":"submitted"}' })).businessGoalAchieved, false);
  assert.equal((await fixture.grade({ answer: JSON.stringify({ status: 'blocked', reason: 'login_required', nextAction: 'user_login', profileAction: 'replace' }) })).businessGoalAchieved, false);
});
test('live-site reports do not become reproducible rankings and expose binding requirements', () => {
  const report = { scenarioGroup: 'live-site', kind: 'agent-evaluation', coverage: catalog.tasks, plan: makePlan(catalog, { group: 'live-site' }), results: [] };
  const comparison = compareReports(report, report);
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.reasons.some(reason => reason.includes('真实网站')));
  const html = renderReport(report);
  assert.ok(html.includes('https://github.com/settings/profile'));
  assert.ok(html.includes('需本地环境绑定和预检'));
  assert.ok(html.includes('16 个设计中的模板'));
});
test('new comparison contract rejects missing or drifted observed environment', () => {
  const report = { environmentSchemaVersion: 1, scenarioGroup: 'synthetic', environmentConfigHash: 'same', kind: 'agent-evaluation', plan: makePlan(catalog, { tasks: ['shopping-sku-compare'], seeds: [1101] }), results: [] };
  const comparison = compareReports(report, report);
  assert.ok(comparison.reasons.some(reason => reason.includes('实际环境缺失')));
});
test('correct blocking counts only for a declared recovery objective and fully passing oracle', () => {
  const execution = { response: { status: 'blocked' } };
  const grade = { businessGoalAchieved: true, mandatoryConstraintsMet: true, checks: [{ passed: true }] };
  assert.equal(classify({ execution, grade }), 'blocked');
  assert.equal(classify({ execution, grade, expectedOutcome: 'blocked' }), 'success');
  assert.equal(classify({ execution, grade: { ...grade, mandatoryConstraintsMet: false }, expectedOutcome: 'blocked' }), 'blocked');
  assert.equal(classify({ execution: { ...execution, timedOut: true }, grade, expectedOutcome: 'blocked' }), 'timeout');
});
