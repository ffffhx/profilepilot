// Real SDK, deterministic local endpoint: no billable model/browser calls.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
const require = createRequire(import.meta.url);
const { providerPricing, HOST_PRICING_ENV } = require('../dist/main/tasks/pricing');
const { providerEnvironment } = require('../dist/main/tasks/provider');
const { workerEnvironment } = require('../dist/main/tasks/service');
const { sdkExecutable } = require('../dist/main/tasks/runtime');
const { costBaseline, applyPricedCost } = require('../dist/main/tasks/cost-accounting');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-price-sdk-'));
const settings = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic' };
let turn = 0;
const server = http.createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url.includes('count_tokens')) return res.end('{"input_tokens":1000}');
  if (!req.url.includes('messages')) return res.end('{}');
  const request = JSON.parse(text); turn++;
  const block = turn === 1 ? { type: 'tool_use', id: 'price-tool', name: 'mcp__fixture__next', input: {} } : { type: 'text', text: 'Pricing verified' };
  const message = { id: `price-message-${turn}`, type: 'message', role: 'assistant', model: request.model, content: [block], stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0, output_tokens: 20 } };
  if (!request.stream) return res.end(JSON.stringify(message));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: block.text } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {}); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const run = async (budget, resume) => {
  let result;
  const next = tool('next', 'Return the next step', {}, async () => ({ content: [{ type: 'text', text: 'continue' }] }));
  const q = query({ prompt: 'Use the provided tool and finish.', options: {
    cwd: root, model: settings.model, tools: [], allowedTools: ['mcp__fixture__next'], settingSources: [],
    mcpServers: { fixture: createSdkMcpServer({ name: 'fixture', tools: [next] }) }, systemPrompt: 'Pricing fixture.',
    managedSettings: providerPricing(settings, new Date('2026-09-24T02:00:00Z')), maxBudgetUsd: budget, maxTurns: 5, resume,
    abortController: new AbortController(),
    env: { ...workerEnvironment(), ...providerEnvironment(settings, 'fixture-key', root), ...HOST_PRICING_ENV, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    spawnClaudeCodeProcess: options => spawn(sdkExecutable(options.command), options.args, { cwd: options.cwd, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }, signal: options.signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  } });
  const timeout = setTimeout(() => q.close(), 45000);
  try { for await (const message of q) if (message.type === 'result') result = message; }
  catch (error) { if (!result) throw new Error(error.message); }
  finally { clearTimeout(timeout); q.close(); }
  assert.ok(result, 'SDK returned a result'); return result;
};
try {
  const first = await run(0.05);
  assert.equal(first.subtype, 'success', JSON.stringify(first));
  const firstUsage = first.modelUsage['deepseek-flash'];
  const price = u => (u.inputTokens * 0.3 + u.cacheReadInputTokens * 0.006 + u.cacheCreationInputTokens * 0.3 + u.outputTokens * 1.2) / 1e6;
  assert.ok(Math.abs(first.total_cost_usd - price(firstUsage)) < 1e-9, JSON.stringify(first.modelUsage));
  assert.equal(firstUsage.costBasis, 'managed');
  // Simulate a legacy saved session whose counter contains old guessed prices.
  const transcript = (await readdir(path.join(root, 'projects'), { recursive: true })).find(name => name.endsWith(`${first.session_id}.jsonl`));
  const file = path.join(root, 'projects', transcript);
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  const old = records.filter(row => row.type === 'cost-state').at(-1);
  assert.ok(old); const guessed = 5.345884;
  old.totalCostUSD = guessed; old.modelUsage['deepseek-flash'].costUSD = guessed; old.hasUnknownModelCost = true;
  await writeFile(file, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const task = { sdkSessionId: first.session_id, usage: { costUsd: first.total_cost_usd }, costAccounting: { version: 'deepseek-2026-09-24', sessionId: first.session_id, sdkUsd: guessed } };
  const baseline = costBaseline(task);
  const resumed = await run(0.05, first.session_id);
  assert.equal(resumed.subtype, 'success', JSON.stringify(resumed));
  applyPricedCost(task, baseline, resumed.total_cost_usd, 'deepseek-2026-09-24');
  assert.ok(task.usage.costUsd < 0.05, 'Old guessed cost must not return on resume');
  const once = task.usage.costUsd;
  applyPricedCost(task, baseline, resumed.total_cost_usd, 'deepseek-2026-09-24');
  assert.equal(task.usage.costUsd, once, 'Cumulative result is not added twice');
  turn = 0;
  const exhausted = await run(0.001);
  assert.equal(exhausted.subtype, 'error_max_budget_usd');
  const evidence = { passed: true, endpoint: 'local deterministic fixture', knownPricing: firstUsage.costBasis, firstCostUsd: first.total_cost_usd, correctedResumedCostUsd: task.usage.costUsd, enforcedBudget: exhausted.subtype };
  await mkdir('test-results/browser-tasks', { recursive: true });
  await writeFile('test-results/browser-tasks/pricing-sdk-result.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) { console.error(error.message); process.exitCode = 1; } finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
