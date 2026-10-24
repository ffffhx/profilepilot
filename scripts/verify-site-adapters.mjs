// Live, read-only smoke test through the existing ProfilePilot browser service.
// Does not claim/resume/switch Profiles. Pass an already-owned task session.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { requestNativeControl } = require('../dist/main/native-control/cli');
const { runSiteAdapter, siteEvaluationValue } = require('../dist/main/site-adapters/runner');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const sessionId = process.argv.includes('--session') ? arg('--session') : undefined;
if (!sessionId) throw Error('Use --session with an existing owned ProfilePilot session.');
const out = path.resolve(process.argv.includes('--output') ? arg('--output') : 'artifacts/site-adapters/live');
await mkdir(out, { recursive: true });
const request = (method, params = {}) => requestNativeControl({ requestId: randomUUID(), sessionId, method, params });
const state = await request('status');
const session = state.sessions.find(s => s.sessionId === sessionId);
if (!session || session.ownership !== 'agent' || session.pauseReason) throw Error('Selected session is not in agent control. Inspect status; do not resume automatically.');
let tests = process.argv.includes('--params-file') ? JSON.parse((await readFile(arg('--params-file'), 'utf8')).replace(/^\uFEFF/, '')) : [
  { operation: 'zhihu.hot', params: { limit: 10 } },
  { operation: 'zhihu.search', params: { query: '浏览器自动化', limit: 10 } },
  { operation: 'bilibili.search', params: { query: '浏览器自动化', limit: 10 } },
  { operation: 'boss.search', params: { query: '前端工程师', city: '101020100', limit: 10 } },
  { operation: 'smzdm.search', params: { query: 'DDR5 32G', limit: 10 } },
  { operation: 'reddit.search', params: { query: 'browser automation', limit: 10 } },
  { operation: 'xiaohongshu.search', params: { query: '浏览器自动化', limit: 10 } },
  { operation: 'wechat.search', params: { query: '浏览器自动化', limit: 10 } },
  { operation: 'youtube.search', params: { query: 'browser automation', limit: 10 } }
];
if (process.argv.includes('--details')) {
  const first = async operation => JSON.parse(await readFile(path.join(out, operation + '.json'), 'utf8')).result.items[0];
  const b = await first('bilibili.search'), r = await first('reddit.search'), x = await first('xiaohongshu.search'), w = await first('wechat.search'), y = await first('youtube.search');
  tests = [
    { operation: 'bilibili.detail', params: { id: b.id } }, { operation: 'bilibili.comments', params: { id: b.id, limit: 10 } },
    { operation: 'reddit.thread', params: { id: r.id, limit: 20 } },
    { operation: 'xiaohongshu.detail', params: { url: x.url } }, { operation: 'xiaohongshu.comments', params: { url: x.url, limit: 10 } },
    { operation: 'wechat.article', params: { url: w.url } },
    { operation: 'youtube.detail', params: { id: y.id } }, { operation: 'youtube.transcript', params: { id: y.id, limit: 10 } }
  ];
  try { const job = await first('boss.search'); if (job) tests.unshift({ operation: 'boss.detail', params: { id: job.id, ...(job.securityId ? { securityId: job.securityId } : {}) } }); } catch { /* BOSS may require sign-in. */ }
}
const reports = [];
for (const input of tests) {
  const started = Date.now();
  let result;
  try {
    result = process.argv.includes('--development-runner') ? await runSiteAdapter(input, {
      evaluate: async expression => {
        const value = siteEvaluationValue(await request('cdp', { method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
        if (process.argv.includes('--trace') && expression.includes('function prepareSitePage')) console.log(JSON.stringify({ preparation: value }));
        return value;
      },
      open: url => request('open', { url })
    }) : await request('site', input);
  } catch (error) {
    // Transport/ownership failure aborts the entire run; it is not a site failure.
    await writeFile(path.join(out, 'interrupted.json'), JSON.stringify({ at: new Date().toISOString(), operation: input.operation, code: error.code, message: error.message }, null, 2));
    throw error;
  }
  const report = { input, elapsedMs: Date.now() - started, result };
  reports.push(report);
  await writeFile(path.join(out, input.operation + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ operation: input.operation, status: result.status, count: result.items.length, elapsedMs: report.elapsedMs, error: result.error,
    sample: result.items.slice(0, 2).map(i => ({ title: i.title, id: i.id })) }));
}
await writeFile(path.join(out, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), platform: process.platform,
  mode: process.argv.includes('--development-runner') ? 'development-runner-over-existing-service' : 'native-service-site-method', reports }, null, 2));
