import assert from 'node:assert/strict';
import test from 'node:test';
import { compareReports, normalizeReport, renderComparison, renderReport } from '../benchmarks/agent-tasks/lib/report.mjs';

test('environment-versioned comparisons pin OS release and expose cleanup failures', () => {
  const before = report({ environmentSchemaVersion: 1, scenarioGroup: 'synthetic', environmentConfigHash: 'same', platform: { os: 'win32', arch: 'x64', node: 'v22', release: '10.0.26100' } });
  for (const row of before.results) {
    row.observedEnvironment = { viewport: { width: 1262, height: 804 }, language: 'zh-CN', timeZone: 'Asia/Shanghai' };
    row.environmentContract = { profile: 'fresh-per-cell', extensions: 'disabled' };
    row.environmentChecks = [{ key: 'fresh-profile', passed: true }];
  }
  assert.equal(compareReports(before, structuredClone(before)).comparable, true);
  const after = structuredClone(before); after.platform.release = '10.0.26200';
  assert.ok(compareReports(before, after).reasons.some(reason => reason.includes('platform.release')));
  after.results[0].status = 'environment_invalid';
  after.results[0].cleanupError = 'Session completion unconfirmed';
  after.results[0].cleanupDetails = { sessionId: 'eval-cleanup-example', cleanupRequired: true };
  const html = renderReport(after);
  assert.ok(html.includes('Session completion unconfirmed'));
  assert.ok(html.includes('eval-cleanup-example'));
});

function report(overrides = {}) {
  const plan = [
    { id: 'resume-1101', taskId: 'career-resume-sync', title: '简历同步', seed: 1101, condition: 'baseline' },
    { id: 'mail-1101', taskId: 'mail-approved-reply', title: '邮件审批', seed: 1101, condition: 'commit-response-loss' },
    { id: 'shop-2202', taskId: 'shopping-sku-compare', title: '商品比较', seed: 2202, condition: 'baseline' }
  ];
  return {
    schemaVersion: 1, suite: 'profilepilot-agent-tasks', suiteVersion: '1.0.0', fixtureVersion: '1.0.0',
    fixtureHash: 'fixture-a', catalogHash: 'catalog-a', runId: 'example-run', kind: 'agent-evaluation',
    adapterConfigHash: 'agent-config-a', agentImplementationHash: 'agent-implementation-a',
    platform: { os: 'win32', arch: 'x64', node: 'v22' }, track: 'matched-browser-dom', preparation: 'fresh-profile-per-cell',
    browser: { mode: 'headless', version: 'test-chrome' },
    budget: { timeoutMs: 120000, maxActions: 60, maxBudgetUsd: 2 },
    adapter: { id: 'driver-a', agent: 'agent-a', model: 'model-a', tool: 'profilepilot', toolVersion: '1.0' },
    revision: { commit: 'abc', dirty: false, codeHashes: { runner: 'r1' } },
    plan, results: plan.map(cell => ({ ...cell, status: 'success', businessGoalAchieved: true, mandatoryConstraintsMet: true,
      checks: [{ id: 'persisted-business-state', passed: true, detail: '独立回读一致' }], elapsedMs: 500,
      preparationMs: 100, usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.02 } })),
    ...overrides
  };
}

test('partial runs retain failed, blocked, environment-invalid and missing cells in the original denominator', () => {
  const run = report();
  run.plan.push({ id: 'refund-3303', taskId: 'purchase-cloud-refund', seed: 3303, condition: 'baseline' });
  run.plan.push({ id: 'oa-3303', taskId: 'formal-upload-submit-record', seed: 3303, condition: 'baseline' });
  run.results[1].status = 'blocked'; run.results[1].businessGoalAchieved = false;
  run.results[2].status = 'environment_invalid'; run.results[2].businessGoalAchieved = false;
  run.results.push({ ...run.plan[3], status: 'failed', businessGoalAchieved: false, mandatoryConstraintsMet: false });
  run.summary = { planned: 1, success: 1, successRate: 1 }; // Never trust a stale denominator.
  const normalized = normalizeReport(run);
  assert.equal(normalized.summary.planned, 5);
  assert.equal(normalized.summary.success, 1);
  assert.equal(normalized.summary.successRate, 0.2);
  for (const status of ['blocked', 'failed', 'environment_invalid', 'not_run']) assert.equal(normalized.summary[status], 1);
  assert.equal(normalized.rows[4].status, 'not_run');
  assert.match(renderReport(run), /1 \/ 5/);
});

test('correct handling and nominal success cannot override an unmet business goal or hard constraint', () => {
  const run = report();
  run.results[0].businessGoalAchieved = false;
  run.results[1].mandatoryConstraintsMet = false;
  const result = normalizeReport(run);
  assert.equal(result.summary.success, 1);
  assert.equal(result.summary.failed, 2);
  assert.equal(compareReports(report(), run).comparable, false);
  const emptyChecks = report(); emptyChecks.results[0].checks = [];
  assert.equal(normalizeReport(emptyChecks).summary.success, 2);
  const failedChecks = report(); failedChecks.results[0].checks[0].passed = false;
  assert.equal(normalizeReport(failedChecks).summary.success, 2);
});

test('unplanned output and duplicate result identities cannot manufacture additional successes', () => {
  const run = report();
  run.results.push({ ...run.results[0] });
  run.results.push({ ...run.results[1], id: 'unplanned' });
  const normalized = normalizeReport(run);
  assert.equal(normalized.summary.planned, 3);
  assert.equal(normalized.summary.success, 2);
  assert.equal(normalized.summary.environment_invalid, 1);
  assert.equal(normalized.unplanned.length, 1);
  assert.equal(compareReports(report(), run).comparable, false);
});

test('revision comparisons accept version changes and unordered plans while retaining failed cells', () => {
  const before = report(); const after = report();
  after.adapter.toolVersion = '2.0'; after.revision = { commit: 'def', dirty: true, codeHashes: { runner: 'r2' } };
  after.plan.reverse(); after.results.pop();
  const comparison = compareReports(before, after);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.after.summary.not_run, 1);
  assert.equal(comparison.delta.success, -1);
  assert.ok(Math.abs(comparison.delta.successRatePoints + 100 / 3) < 1e-9);
  assert.match(comparison.warnings.join(' '), /未运行/);
});

test('predeclared repetitions remain independent trials instead of being deduplicated or counted as retries', () => {
  const run = report();
  const cell = { ...run.plan[0], id: 'resume-1101-r2', repetition: 2 };
  run.plan.push(cell);
  run.results.push({ ...run.results[0], ...cell, status: 'timeout', businessGoalAchieved: false });
  const normalized = normalizeReport(run);
  assert.equal(normalized.summary.planned, 4);
  assert.equal(normalized.summary.successRate, 0.75);
  assert.deepEqual(normalized.issues, []);
  assert.equal(compareReports(run, structuredClone(run)).comparable, true);
  assert.equal(compareReports(run, structuredClone(run)).rows.length, 4);
  assert.equal(compareReports(report(), run).comparable, false);
});

test('tool and agent modes make different attribution claims', () => {
  const before = report(); const after = report();
  after.adapter.id = 'another-driver'; after.adapter.tool = 'another-browser-tool';
  assert.equal(compareReports(before, after).comparable, false);
  assert.equal(compareReports(before, after, { mode: 'tools' }).comparable, true);
  after.adapter.model = 'another-model';
  assert.equal(compareReports(before, after, { mode: 'tools' }).comparable, false);
  const agents = compareReports(before, after, { mode: 'agents' });
  assert.equal(agents.comparable, true);
  assert.match(agents.warnings.join(' '), /全栈/);
  assert.match(renderComparison(before, after, { mode: 'agents' }), /another-model/);
});

test('revision mode pins Agent configuration, implementation and prompt identity while permitting observed tool-version changes', () => {
  for (const key of ['adapterConfigHash', 'agentImplementationHash']) {
    const before = report(); const after = report();
    after[key] = `${before[key]}-changed`;
    after.revision.codeHashes['benchmarks/agent-tasks/adapters/profilepilot-sdk.mjs'] = 'modified-prompt';
    const changed = compareReports(before, after);
    assert.equal(changed.comparable, false);
    assert.equal(changed.delta, null);
    assert.match(changed.reasons.join(' '), new RegExp(key));
    delete after[key];
    assert.equal(compareReports(before, after).comparable, false);
  }
  const before = report(); const after = report();
  after.adapter.toolVersion = '2.0';
  after.revision.codeHashes['dist/main/profilepilot-cli.cjs'] = 'new-cli-build';
  assert.equal(compareReports(before, after).comparable, true);
  after.agentImplementationHash = 'different-adapter';
  after.adapterConfigHash = 'different-tool-driver-config';
  const tools = compareReports(before, after, { mode: 'tools' });
  assert.equal(tools.comparable, true);
  assert.match(tools.warnings.join(' '), /提示策略.*人工核实等价/);
  assert.equal(compareReports(before, after, { mode: 'agents' }).comparable, true);
});

test('code changes during either run invalidate comparisons without requiring integrity metadata on older reports', () => {
  const before = report(); const after = report();
  assert.equal(compareReports(before, after).comparable, true);
  after.integrity = { codeStable: false };
  for (const mode of ['revision', 'tools', 'agents']) {
    const comparison = compareReports(before, after, { mode });
    assert.equal(comparison.comparable, false);
    assert.equal(comparison.delta, null);
    assert.match(comparison.reasons.join(' '), /执行期间代码发生变化/);
    assert.equal(compareReports(after, before, { mode }).comparable, false);
  }
  assert.match(renderReport(after), /运行完整性/);
});

test('each environment or task-contract mismatch suppresses ranking and percentage-point deltas', () => {
  const changes = [
    run => { run.fixtureHash = 'different'; }, run => { run.catalogHash = 'different'; },
    run => { run.suiteVersion = '2.0.0'; }, run => { run.fixtureVersion = '2.0.0'; },
    run => { run.track = 'screenshot-only'; }, run => { run.preparation = 'fresh-fixture-per-cell'; },
    run => { run.platform.os = 'darwin'; }, run => { run.platform.arch = 'arm64'; },
    run => { run.browser.mode = 'headful'; }, run => { run.browser.version = 'other-chrome'; },
    run => { delete run.browser; }, run => { run.browser.version = 'unknown'; },
    run => { run.budget.maxActions += 1; }, run => { run.plan[0].seed = 3303; run.results[0].seed = 3303; },
    run => { delete run.fixtureHash; }, run => { delete run.budget.maxBudgetUsd; }
  ];
  for (const mutate of changes) {
    const before = report(); const after = report(); mutate(after);
    const result = compareReports(before, after);
    assert.equal(result.comparable, false, mutate.toString());
    assert.equal(result.delta, null);
    const html = renderComparison(before, after);
    assert.match(html, /契约不可比/);
    assert.doesNotMatch(html, /完成率变化 .*?个百分点/);
  }
});

test('reference-driver selftests are visibly separate and never comparable model evaluations', () => {
  const smoke = report({ kind: 'harness-selftest' });
  const html = renderReport(smoke);
  assert.match(html, /评测框架自检结果/);
  assert.match(html, /不代表模型成功率/);
  assert.match(html, /自检通过 \/ 计划/);
  assert.equal(compareReports(smoke, smoke).comparable, false);
  assert.equal(compareReports(smoke, smoke).delta, null);
});

test('mixed model identities within a run block aggregate comparisons', () => {
  const run = report();
  run.results[0].metadata = { model: 'other-model' };
  const result = compareReports(report(), run);
  assert.equal(result.comparable, false);
  assert.match(result.reasons.join(' '), /model 身份/);
  const wrongTrack = report();
  wrongTrack.results[0].metadata = { track: 'screenshot-only' };
  assert.equal(compareReports(report(), wrongTrack).comparable, false);
  const unresolvedModel = report(); unresolvedModel.adapter.model = 'configured';
  assert.equal(compareReports(unresolvedModel, structuredClone(unresolvedModel)).comparable, false);
  const unresolvedTool = report(); unresolvedTool.adapter.toolVersion = 'local-build';
  assert.equal(compareReports(unresolvedTool, structuredClone(unresolvedTool)).comparable, false);
  const mixedBrowsers = report(); mixedBrowsers.results[0].runtime = { browserMode: 'headless', chromeVersion: 'different-chrome' };
  assert.equal(compareReports(report(), mixedBrowsers).comparable, false);
  const externalBrowser = report(); externalBrowser.results[0].metadata = { browser: { mode: 'headed', version: 'test-chrome' } };
  assert.equal(compareReports(report(), externalBrowser).comparable, false);
});

test('unknown or partially reported costs are not presented as complete zero-cost measurements', () => {
  const run = report();
  for (const result of run.results) delete result.usage;
  assert.equal(normalizeReport(run).summary.totalCostUsd, null);
  assert.match(renderReport(run), /未报告/);
  run.results[0].usage = { costUsd: 0 };
  const normalized = normalizeReport(run);
  assert.equal(normalized.summary.totalCostUsd, 0);
  assert.equal(normalized.summary.costReportedCells, 1);
  assert.equal(compareReports(report(), run).delta.costUsd, null);
});

test('untrusted task names, errors and artifact strings stay inert in standalone HTML', () => {
  const payload = '<script>alert("secret")</script><img src=x onerror=alert(1)>';
  const run = report({ runId: payload });
  run.plan[0].title = payload; run.results[0].title = payload;
  run.results[0].error = payload; run.results[0].artifacts = ['javascript:alert(1)', payload];
  run.results[0].checks[0].detail = payload;
  for (const html of [renderReport(run), renderComparison(run, run)]) {
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('href="javascript:'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Content-Security-Policy/);
  }
});
