#!/usr/bin/env node
import { mkdir, writeFile, readFile, rename, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createFixture, solveFixtureForSmoke, TASK_IDS } from './lib/fixture.mjs';
import { renderReport, renderComparison } from './lib/report.mjs';
import { hash, SUITE, makePlan, summarize, classify } from './lib/contracts.mjs';
import { readJson, loadAdapter, executeAdapter, collectArtifacts, redact, redactValue } from './lib/process.mjs';
import { createRecoveryFixture, solveRecoveryForSmoke } from './lib/recovery.mjs';
import { prepareLiveScenario } from './lib/live-sites.mjs';
import { validateEnvironmentContract } from './lib/environments.mjs';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const suiteRoot = fileURLToPath(new URL('./', import.meta.url));
const require = createRequire(import.meta.url);

const help = `ProfilePilot Agent task benchmark

  npm run eval:list
  npm run eval:smoke                         # 8 tasks x 3 seeds; harness self-test only
  npm run eval:run -- --adapter benchmarks/agent-tasks/adapters/profilepilot-sdk.json
  npm run eval:run -- --tasks mail-approved-reply --seeds 1101 --condition commit-response-loss
  npm run eval:report -- --run test-results/agent-tasks/<run-id>
  npm run eval:compare -- --before <run-dir> --after <run-dir> --mode revision
  npm run eval:serve -- --run <run-dir> --detach
  npm run eval:run -- --group live-site --environment <local-environment.json>
  npm run eval:smoke -- --group recovery

Options: --tasks comma-separated IDs; --seeds comma-separated integers; --repeat 1..20
  --condition baseline|commit-response-loss; --timeout-ms 240000; --max-actions 80
  --max-budget-usd 1; --output <new-run-dir>; --adapter <JSON config>
  --mode revision|tools|agents (comparison); --port 0 (serve; localhost only)
  --group synthetic|live-site|recovery; --environment <local bindings JSON>

Agent runs consume model credits. Synthetic/recovery use isolated Gateway Profiles.
Live-site uses an explicitly bound existing extension Profile and preserves login.
External adapters are trusted local processes, not sandboxed.
`;

export function argumentsFor(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, adapter: { type: 'string' }, tasks: { type: 'string' }, seeds: { type: 'string' },
    condition: { type: 'string', default: 'baseline' }, repeat: { type: 'string', default: '1' },
    'timeout-ms': { type: 'string', default: '240000' }, 'max-actions': { type: 'string', default: '80' }, 'max-budget-usd': { type: 'string', default: '1' },
    output: { type: 'string' }, run: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, mode: { type: 'string', default: 'revision' },
    port: { type: 'string', default: '0' }, detach: { type: 'boolean' }, token: { type: 'string' },
    group: { type: 'string', default: 'synthetic' }, environment: { type: 'string' }
  } });
  if (positionals.length > 1) throw Error('Only one command is accepted');
  return { command: positionals[0] || 'list', ...values };
}

async function saveJson(file, value) {
  await writeFile(`${file}.tmp`, JSON.stringify(redactValue(value), null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}

async function codeVersion() {
  const files = ['benchmarks/agent-tasks/run.mjs', 'benchmarks/agent-tasks/catalog.json', 'benchmarks/agent-tasks/lib/contracts.mjs', 'benchmarks/agent-tasks/lib/process.mjs', 'benchmarks/agent-tasks/lib/fixture.mjs', 'benchmarks/agent-tasks/lib/recovery.mjs', 'benchmarks/agent-tasks/lib/live-sites.mjs', 'benchmarks/agent-tasks/lib/environments.mjs', 'benchmarks/agent-tasks/lib/report.mjs', 'benchmarks/agent-tasks/lib/gateway.mjs', 'benchmarks/agent-tasks/adapters/profilepilot-sdk.mjs', 'dist/main/profilepilot-cli.cjs', 'dist/main/profilepilot-agent-browser-wrapper.cjs', 'package-lock.json'];
  const codeHashes = {};
  files.push('benchmarks/agent-tasks/environments.schema.json');
  for (const file of files) { try { codeHashes[file] = hash(await readFile(path.join(repoRoot, file))); } catch { codeHashes[file] = null; } }
  let commit = 'unavailable', dirty = null, dirtyStateHash = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    dirty = !!status.trim(); dirtyStateHash = hash(status);
  } catch {}
  return { commit, dirty, dirtyStateHash, codeHashes };
}

async function persist(directory, report) {
  report.summary = summarize(report.plan, report.results);
  await saveJson(path.join(directory, 'report.json'), report);
  await writeFile(path.join(directory, 'report.html'), renderReport(redactValue(report)));
}

function validateBudget(options) {
  const budget = { timeoutMs: Number(options['timeout-ms']), maxActions: Number(options['max-actions']), maxBudgetUsd: Number(options['max-budget-usd']) };
  if (!Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs < 1000 || budget.timeoutMs > 3600000) throw Error('timeout-ms must be 1000..3600000');
  if (!Number.isSafeInteger(budget.maxActions) || budget.maxActions < 1 || budget.maxActions > 1000) throw Error('max-actions must be 1..1000');
  if (!Number.isFinite(budget.maxBudgetUsd) || budget.maxBudgetUsd <= 0 || budget.maxBudgetUsd > 100) throw Error('max-budget-usd must be >0 and <=100');
  return budget;
}

export async function runSuite(options) {
  const catalogFile = path.join(suiteRoot, 'catalog.json'), catalog = await readJson(catalogFile);
  const selftest = options.command === 'smoke';
  const group = options.group || 'synthetic';
  if (selftest && group === 'live-site') throw Error('Live websites have no synthetic smoke score; use run with a bound environment');
  const plan = makePlan(catalog, { tasks: options.tasks?.split(','), seeds: options.seeds?.split(',').map(Number), condition: options.condition, repeat: Number(options.repeat || 1), group });
  if (group === 'synthetic') for (const cell of plan) if (!TASK_IDS.includes(cell.taskId)) throw Error(`Catalog task has no fixture: ${cell.taskId}`);
  const environmentBundle = options.environment ? await readJson(path.resolve(options.environment)) : {};
  const environmentContracts = Object.fromEntries([...new Set(plan.map(cell => cell.taskId))].map(id => {
    const checked = validateEnvironmentContract(environmentBundle.environments?.[id]);
    return [id, checked.ok ? checked.contract : { status: 'unbound-or-invalid', reasons: checked.reasons }];
  }));
  const budget = validateBudget(options);
  const adapterFile = path.resolve(options.adapter || path.join(suiteRoot, `adapters/${group === 'live-site' ? 'profilepilot-extension' : 'profilepilot-sdk'}.json`));
  const config = selftest ? { id: 'reference-http-selftest', agent: 'deterministic-reference', model: 'none', tool: 'fixture-http', toolVersion: '1.0.0', track: 'harness-selftest', environment: 'external-browser' }
    : await loadAdapter(adapterFile, repoRoot);
  const registeredConfig = selftest ? config : await readJson(adapterFile);
  if (group === 'live-site' && config.environment !== 'existing-profilepilot-extension') throw Error('Live-site currently requires the existing-profilepilot-extension adapter');
  if (group !== 'live-site' && config.environment === 'existing-profilepilot-extension') throw Error('Synthetic/recovery cannot use an existing personal Profile');
  const entrypointHashes = {};
  if (!selftest) for (const arg of config.args) {
    if (!path.isAbsolute(arg)) continue;
    try { if ((await stat(arg)).isFile()) entrypointHashes[path.relative(repoRoot, arg).replaceAll('\\', '/')] = hash(await readFile(arg)); } catch {}
  }
  let sdkVersion = null;
  if (config.agent === 'claude-agent-sdk') sdkVersion = (await readJson(path.join(repoRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'))).version;
  const agentImplementationHash = Object.keys(entrypointHashes).length ? hash({ entrypointHashes, sdkVersion, node: process.version }) : null;
  const runId = `${selftest ? 'selftest' : 'agent'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.resolve(options.output || path.join(repoRoot, 'test-results/agent-tasks', runId));
  await mkdir(path.dirname(directory), { recursive: true });
  // Never overwrite an earlier run or quietly rerun only failed cells.
  await mkdir(directory, { recursive: false });
  const report = {
    schemaVersion: 1, environmentSchemaVersion: 1, scenarioGroup: group, suite: SUITE, suiteVersion: catalog.version, fixtureVersion: group === 'synthetic' ? catalog.fixtureVersion : group === 'recovery' ? 'recovery-1.0.1' : 'live-github-1.0.0',
    catalogHash: hash(await readFile(catalogFile)), fixtureHash: hash(await readFile(path.join(suiteRoot, `lib/${group === 'synthetic' ? 'fixture' : group === 'recovery' ? 'recovery' : 'live-sites'}.mjs`))),
    environmentConfigHash: hash(environmentBundle.environments || {}),
    ...(group === 'live-site' ? { environmentContracts } : {}),
    coverage: catalog.tasks.map(({ id, title, group, status, environment, readiness }) => ({ id, title, group, status, environment, readiness })),
    runId, kind: selftest ? 'harness-selftest' : 'agent-evaluation', startedAt: new Date().toISOString(),
    platform: { os: process.platform, arch: process.arch, node: process.version, release: os.release() },
    track: config.track, preparation: group === 'live-site' ? 'reuse-designated-profile-preserve-auth' : config.environment === 'isolated-profilepilot-gateway' ? 'fresh-profile-per-cell' : 'fresh-fixture-per-cell', budget,
    adapter: { id: config.id, agent: config.agent, model: config.model, tool: config.tool, toolVersion: config.toolVersion },
    adapterConfigHash: hash(registeredConfig), agentImplementationHash, agentImplementation: { entrypointHashes, sdkVersion }, revision: await codeVersion(), plan, results: [],
    limitations: [selftest ? 'Deterministic reference HTTP driver; not Agent or ProfilePilot capability evidence.' : 'Local cooperative execution, not an OS security boundary. External adapters must be trusted.', group === 'live-site' ? 'Live-site results are dated acceptance evidence, not reproducible leaderboard scores. Extension ID and network require an operator attestation; extension version and page environment are observed.' : group === 'recovery' ? 'Controlled local login-expiry handling; does not simulate real extension disconnect, MFA or user takeover.' : 'Synthetic local business tasks; scores do not establish performance on live websites, Android or desktop.', 'No pass-at-k: all registered seeds and repetitions remain in the denominator.']
  };
  await saveJson(path.join(directory, 'manifest.json'), report); // Frozen before any preparation or model execution.
  await persist(directory, report);
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  // Resolve the credential vault before the fixture changes CPM_DATA_DIR.
  const oldProviderRoot = process.env.PP_TASK_PROVIDER_ROOT;
  const invocationCwd = process.cwd();
  process.chdir(repoRoot); // Existing isolated Gateway helper resolves built files relative to the repository.
  if (['isolated-profilepilot-gateway', 'existing-profilepilot-extension'].includes(config.environment) && !oldProviderRoot) {
    try { process.env.PP_TASK_PROVIDER_ROOT = path.join(require(path.join(repoRoot, 'dist/main/fs-util.js')).defaultDataDir(), 'browser-tasks'); } catch {}
  }
  console.log(`${report.kind}: ${plan.length} registered cells → ${directory}`);
  const lockedIdentity = {};
  try {
    for (const cell of plan) {
      if (abort.signal.aborted) break;
      const cellDir = path.join(directory, 'cells', cell.id), workspace = path.join(cellDir, 'agent');
      await mkdir(path.join(workspace, 'outputs'), { recursive: true });
      await mkdir(path.join(cellDir, 'private'), { recursive: true });
      let fixture, gateway, execution, grade, artifacts = {}, artifactsError, phase = 'prepare';
      const prepared = Date.now();
      const sessionId = `pp-eval-${randomUUID()}`;
      const result = { ...cell, status: 'environment_invalid', businessGoalAchieved: false, mandatoryConstraintsMet: false, checks: [], relativeDir: `cells/${cell.id}`, artifacts: [], elapsedMs: 0, preparationMs: 0 };
      try {
        fixture = group === 'live-site' ? await prepareLiveScenario({ taskId: cell.taskId, environment: environmentBundle.environments?.[cell.taskId], bindings: environmentBundle.bindings, attestation: environmentBundle.attestation, repoRoot, privateDir: path.join(cellDir, 'private'), sessionId })
          : group === 'recovery' ? await createRecoveryFixture(cell) : await createFixture({ ...cell, workspace });
        if (!fixture.baselineHash || fixture.fixtureVersion !== report.fixtureVersion) throw Error('Fixture reset/version invariant failed');
        result.baselineHash = fixture.baselineHash;
        if (config.environment === 'isolated-profilepilot-gateway') {
          const { startEvaluationGateway } = await import('./lib/gateway.mjs');
          gateway = await startEvaluationGateway();
          result.runtime = gateway.metadata;
          const browser = gateway.browser || { mode: gateway.metadata?.browserMode, version: gateway.metadata?.chromeVersion };
          if (report.browser && JSON.stringify(report.browser) !== JSON.stringify(browser)) throw Error('Browser identity changed within this registered run');
          report.browser = browser;
          result.environmentContract = gateway.metadata.environmentContract;
          result.observedEnvironment = gateway.metadata.observedEnvironment;
          result.environmentChecks = gateway.metadata.environmentChecks;
        }
        if (group === 'live-site') {
          result.observedEnvironment = fixture.observedEnvironment;
          result.environmentContract = environmentContracts[cell.taskId];
          result.environmentChecks = [{ key: 'prepared-environment-contract', passed: true }];
          result.environmentContractHash = hash(environmentBundle.environments[cell.taskId]);
          if (report.browser && JSON.stringify(report.browser) !== JSON.stringify(fixture.browser)) throw Error('Browser changed within registered live run');
          report.browser = fixture.browser;
        }
        const request = {
          protocolVersion: 1, runId: `${runId}/${cell.id}`, sessionId,
          task: { id: cell.taskId, seed: cell.seed, condition: cell.condition, prompt: fixture.prompt, url: fixture.url, attachments: fixture.attachments, ...(group === 'live-site' ? { readOnly: true, allowedOrigins: ['https://github.com'], allowedUrls: [fixture.url] } : {}) },
          workspace, budget, environment: { cdp: gateway?.port, control: fixture.control, route: 'browser', track: config.track }
        };
        await saveJson(path.join(workspace, 'task.json'), request);
        result.preparationMs = Date.now() - prepared;
        phase = 'execute';
        if (selftest) {
          const start = Date.now(), solved = await (group === 'recovery' ? solveRecoveryForSmoke : solveFixtureForSmoke)(fixture);
          artifacts = solved.artifacts || {};
          for (const [name, content] of Object.entries(artifacts)) {
            if (path.basename(name) !== name) throw Error('Invalid selftest artifact name');
            await writeFile(path.join(workspace, 'outputs', name), String(content));
          }
          execution = { response: { protocolVersion: 1, status: 'completed', answer: solved.answer || '', metadata: { agent: config.agent, model: config.model, tool: config.tool, toolVersion: config.toolVersion, track: config.track } }, elapsedMs: Date.now() - start };
        } else execution = await executeAdapter({ ...config, ...lockedIdentity }, request, { signal: abort.signal });
        if (execution.cleanupFailed) { result.cleanupError = execution.error; abort.abort(); }
        for (const key of ['model', 'toolVersion']) {
          const value = execution.response?.metadata?.[key];
          if (typeof value === 'string' && value && !['configured', 'local-build', 'unknown'].includes(value)) lockedIdentity[key] ||= value;
        }
        result.elapsedMs = execution.elapsedMs;
        result.usage = execution.response?.usage;
        result.metadata = execution.response?.metadata;
        if (config.environment === 'external-browser' && execution.response?.metadata?.browser) {
          const browser = execution.response.metadata.browser;
          if (report.browser && JSON.stringify(report.browser) !== JSON.stringify(browser)) execution.error = 'Browser identity changed within this registered run';
          report.browser = browser;
        }
        result.answer = execution.response?.answer;
        await writeFile(path.join(cellDir, 'adapter.stderr.log'), execution.stderr || '');
        await saveJson(path.join(cellDir, 'response.json'), execution.response || { error: execution.error });
        try { artifacts = await collectArtifacts(workspace); } catch (error) { artifactsError = redact(error.message); }
        phase = 'grade';
        grade = await fixture.grade({ answer: execution.response?.answer || '', artifacts, metadata: execution.response?.metadata });
        if (typeof grade.businessGoalAchieved !== 'boolean' || typeof grade.mandatoryConstraintsMet !== 'boolean' || !Array.isArray(grade.checks) || !grade.checks.length) throw Error('Invalid grader contract');
        Object.assign(result, grade, { status: classify({ execution, grade, artifactsError, expectedOutcome: group === 'recovery' ? 'blocked' : 'completed' }), artifacts: Object.keys(artifacts) });
        const errors = [execution.error, artifactsError, execution.response?.error, execution.response?.status !== 'completed' ? execution.response?.answer : null].filter(Boolean);
        if (errors.length) result.error = redact(errors.join('; '));
        if (execution.response?.metadata) {
          // Preserve the declared configuration in manifest; record observed model identity for comparisons.
          for (const key of ['model', 'toolVersion']) if (report.adapter[key] === 'configured' || report.adapter[key] === 'local-build') report.adapter[key] = execution.response.metadata[key] || report.adapter[key];
        }
      } catch (error) {
        result.status = phase === 'execute' ? 'failed' : 'environment_invalid';
        result.error = `${phase}: ${redact(error.message)}`;
        result.environmentIssues = error.details;
        if (error.cleanupError) {
          result.cleanupError = redact(error.cleanupError);
          result.cleanupDetails = error.cleanupDetails;
          abort.abort();
        }
        result.environmentContract ||= error.environmentContract;
        result.observedEnvironment ||= error.observedEnvironment;
        result.environmentChecks ||= error.preflightChecks;
        result.preparationMs ||= Date.now() - prepared;
      } finally {
        if (fixture) {
          try { await saveJson(path.join(cellDir, 'private/state.json'), await fixture.snapshot()); } catch (error) { result.evidenceError = redact(error.message); }
        }
        try { await gateway?.close(); } catch (error) { result.cleanupError = redact(error.message); result.status = 'environment_invalid'; abort.abort(); }
        try { await fixture?.close(); } catch (error) { result.cleanupError = redact(error.message); result.cleanupDetails = error.details; result.status = 'environment_invalid'; abort.abort(); }
      }
      await saveJson(path.join(cellDir, 'result.json'), result);
      report.results.push(result);
      await persist(directory, report);
      console.log(`[${report.results.length}/${plan.length}] ${cell.id}: ${result.status}${result.error || result.cleanupError ? ` (${[result.error, result.cleanupError].filter(Boolean).join('; ')})` : ''}`);
    }
  } finally {
    for (const cell of plan) if (!report.results.some(result => result.id === cell.id)) report.results.push({ ...cell, status: 'not_run', businessGoalAchieved: false, mandatoryConstraintsMet: false, checks: [], error: 'Run interrupted before this registered cell' });
    try {
      report.completedAt = new Date().toISOString(); report.interrupted = abort.signal.aborted;
      report.endRevision = await codeVersion();
      report.integrity = { codeStable: hash(report.revision.codeHashes) === hash(report.endRevision.codeHashes) };
      await persist(directory, report);
    } finally {
      process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
      if (oldProviderRoot === undefined) delete process.env.PP_TASK_PROVIDER_ROOT; else process.env.PP_TASK_PROVIDER_ROOT = oldProviderRoot;
      process.chdir(invocationCwd);
    }
  }
  console.log(`Report: ${path.join(directory, 'report.html')}`);
  return { report, directory };
}

async function reportFile(input) {
  if (!input) throw Error('A run directory or report.json is required');
  const resolved = path.resolve(input);
  return (await stat(resolved)).isDirectory() ? path.join(resolved, 'report.json') : resolved;
}

export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.help) { console.log(help); return; }
  if (options.command === 'list') {
    const catalog = await readJson(path.join(suiteRoot, 'catalog.json'));
    console.log(`${catalog.suite} v${catalog.version}`);
    for (const task of catalog.tasks) console.log(`${task.status.padEnd(7)} ${(task.group || 'synthetic').padEnd(10)} ${task.id.padEnd(30)} ${task.route.padEnd(7)} ${task.title}`);
    console.log('\nready = implementation available; live-site additionally requires a bound, validated environment. planned = design only. Groups run separately.');
  } else if (['smoke', 'run'].includes(options.command)) {
    const { report } = await runSuite(options);
    if (report.summary.success !== report.summary.planned) process.exitCode = 1;
  } else if (options.command === 'report') {
    const file = await reportFile(options.run), report = await readJson(file);
    await persist(path.dirname(file), report); console.log(path.join(path.dirname(file), 'report.html'));
  } else if (options.command === 'compare') {
    if (!['revision', 'tools', 'agents'].includes(options.mode)) throw Error('Comparison mode must be revision|tools|agents');
    const before = await readJson(await reportFile(options.before)), after = await readJson(await reportFile(options.after));
    const output = path.resolve(options.output || path.join(repoRoot, 'test-results/agent-tasks', `comparison-${Date.now()}.html`));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, renderComparison(before, after, { mode: options.mode })); console.log(output);
  } else if (options.command === 'serve') {
    const { serve, detachServer } = await import('./lib/serve.mjs');
    const file = await reportFile(options.run);
    await (options.detach ? detachServer : serve)({ run: path.dirname(file), port: Number(options.port), token: options.token });
  } else throw Error(`Unknown command ${options.command}\n${help}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(redact(error.stack || error.message)); process.exitCode = 1; });
