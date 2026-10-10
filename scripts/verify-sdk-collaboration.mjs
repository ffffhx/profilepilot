// Real SDK/CLI, deterministic local Anthropic-compatible endpoint; no API key or paid model.
import http from 'node:http';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { workerEnvironment } = require('../dist/main/tasks/service');
const { authorizeTaskRead } = require('../dist/main/tasks/files');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-collaboration-'));
const selected = path.join(root, 'selected.txt'), privateFile = path.join(root, 'private.txt');
await writeFile(selected, 'APPROVED_COLLABORATION_MATERIAL');
await writeFile(privateFile, 'PRIVATE_CHILD_READ_MUST_NOT_LEAK');
const requests = [], messages = [], turns = { main: 0, alpha: 0, beta: 0 };
const background = process.argv.includes('--background');
const followup = process.argv.includes('--followup');
const stopMode = process.argv.includes('--stop');
let stopRequested = false;
const started = new Set();
let peak = 0, active = 0, peerSent;
const peerReady = new Promise(resolve => { peerSent = resolve; });
let releaseBoth;
const bothReady = new Promise(resolve => { releaseBoth = resolve; });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = text => ({ type: 'text', text });
function reply(res, body, content) {
  const stop = content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  content.forEach((block, index) => {
    send('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : text('') });
    send('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {}); res.end();
}
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!req.url?.includes('messages') || req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":100}'); return; }
    const body = JSON.parse(raw), names = body.tools?.map(t => t.name) || [];
    const content = JSON.stringify(body.messages);
    const role = names.includes('Agent') || names.includes('Task') ? 'main' : content.includes('ALPHA_JOB') ? 'alpha' : content.includes('BETA_JOB') ? 'beta' : 'aux';
    requests.push({ role, body });
    if (role === 'aux') return reply(res, body, [text('Auxiliary response')]);
    const turn = ++turns[role];
    if (role === 'main') {
      if (turn === 1) return reply(res, body, ['alpha', 'beta'].map(name => tool(`spawn_${name}`, names.includes('Agent') ? 'Agent' : 'Task', {
        name, subagent_type: name === 'alpha' ? 'researcher' : 'reviewer', description: `Analyze ${name}`, prompt: `${name.toUpperCase()}_JOB. Analyze selected material.`, run_in_background: background
      })));
      const reports = content.includes('ALPHA_RESULT_VERIFIED') && content.includes('BETA_RESULT_VERIFIED');
      if (reports && followup && !content.includes('followup_alpha')) return reply(res, body, [tool('followup_alpha', 'SendMessage', { to: 'alpha', message: 'FOLLOWUP_REQUEST: review the combined findings' })]);
      if (reports && (!followup || content.includes('ALPHA_FOLLOWUP_VERIFIED')) && !content.includes('main_finish')) return reply(res, body, [tool('main_finish', 'mcp__profilepilot__finish', { status: 'completed', responseOnly: true, summary: 'MAIN_COMBINED_ALPHA_AND_BETA', evidence: [], remaining: [] })]);
      return reply(res, body, [text(reports ? 'MAIN_COMBINED_ALPHA_AND_BETA' : 'Waiting for both reports')]);
    }
    if (turn === 1) {
      started.add(role); active++; peak = Math.max(peak, active);
      if (started.size === 2) { releaseBoth(); if (stopMode) { stopRequested = true; child.send({ kind: 'stop' }); } }
      await bothReady;
      return reply(res, body, [tool(`${role}_read`, 'Read', { file_path: selected })]);
    }
    if (role === 'alpha' && turn === 2) return reply(res, body, [tool('peer_message', 'SendMessage', { to: 'beta', message: 'ALPHA_TO_BETA_EVIDENCE' })]);
    if (role === 'alpha' && turn === 3) {
      peerSent();
      return reply(res, body, [tool('private_read', 'Read', { file_path: privateFile }), tool('child_finish', 'mcp__profilepilot__finish', { status: 'completed', responseOnly: true, summary: 'MUST_NOT_FINISH', evidence: [], remaining: [] })]);
    }
    if (role === 'beta' && turn === 2) {
      await peerReady;
      return reply(res, body, [tool('beta_again', 'Read', { file_path: selected })]);
    }
    active = Math.max(0, active - 1);
    return reply(res, body, [text(role === 'alpha' && content.includes('FOLLOWUP_REQUEST') ? 'ALPHA_FOLLOWUP_VERIFIED' : `${role.toUpperCase()}_RESULT_VERIFIED`)]);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = fork(path.resolve('dist/main/tasks/worker.js'), [], { cwd: root, env: workerEnvironment(), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let stderr = ''; child.stderr.on('data', data => stderr += data); child.stdout.resume();
const output = path.resolve('test-results/browser-tasks');
try {
  const outcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`SDK collaboration timeout: ${JSON.stringify(turns)} ${stderr}`)); }, 55000);
    child.on('message', message => {
      messages.push(message);
      if (message.kind === 'tool') child.send({ kind: 'tool_result', id: message.id, result: message.name === 'authorize_read'
        ? authorizeTaskRead({ attachments: [{ path: selected }] }, message.args.path) : { content: [text('Product tool')] } });
      if (message.kind === 'result') { clearTimeout(timer); resolve(message); }
      if (message.kind === 'error') { clearTimeout(timer); reject(new Error(message.text)); }
    });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); if (!messages.some(m => m.kind === 'result')) reject(new Error(`Worker exit ${code}: ${stderr}`)); });
  });
  child.send({ kind: 'start', cwd: root, apiKey: 'local-fixture-only', settings: { model: 'claude-sonnet-4-6', baseUrl: `http://127.0.0.1:${server.address().port}` },
    task: { id: 'collaboration-fixture', profileId: 'fixture', title: '并行协作验证', prompt: '请并行分析并交叉复核材料', profileName: 'Fixture', authorization: '', materials: [], attachments: [{ id: 'selected', path: selected }], items: [], plan: [], events: [], receipts: [], needsReconciliation: false, limits: { actions: 10, budgetUsd: 2 }, usage: { actions: 0, costUsd: 0 } } });
  const result = await outcome;
  if (stopMode) {
    assert.equal(stopRequested, true);
    assert.equal(peak, 2);
    assert.equal(messages.some(m => m.kind === 'tool'), false, 'No tools may execute after stop');
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error('Stopped worker did not exit')), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'sdk-collaboration-stop-result.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), stopRequested, peak, noToolsAfterStop: true, workerExited: true }, null, 2));
    console.log('PASS real SDK: stopping parent cancels both in-flight children and exits worker');
  } else {
  assert.equal(result.success, true);
  assert.equal(peak, 2, 'Both subagents must reach the endpoint before either receives a response');
  const finalMain = JSON.stringify(requests.filter(r => r.role === 'main').at(-1).body.messages);
  assert.ok(finalMain.includes('ALPHA_RESULT_VERIFIED') && finalMain.includes('BETA_RESULT_VERIFIED'), 'Both reports must return to parent');
  if (followup) assert.ok(finalMain.includes('ALPHA_FOLLOWUP_VERIFIED'), 'Parent can resume a named agent by message');
  assert.ok(requests.some(r => r.role === 'beta' && JSON.stringify(r.body.messages).includes('ALPHA_TO_BETA_EVIDENCE')), 'Peer message must reach recipient context');
  assert.equal(JSON.stringify(requests).includes('PRIVATE_CHILD_READ_MUST_NOT_LEAK'), false);
  assert.equal(messages.filter(m => m.kind === 'tool' && m.name === 'finish').length, 1, 'Only the parent can finish');
  assert.equal(messages.find(m => m.kind === 'tool' && m.name === 'finish').args.summary, 'MAIN_COMBINED_ALPHA_AND_BETA');
  for (const name of ['alpha', 'beta']) {
    assert.ok(messages.some(m => m.kind === 'agent_activity' && m.name === name), `Activity includes ${name}`);
    assert.ok(messages.some(m => m.kind === 'agent_activity' && m.name === name && m.status === 'completed'), `Completion includes ${name}`);
  }
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `sdk-collaboration${background ? '-background' : ''}${followup ? '-followup' : ''}-result.json`), JSON.stringify({ passed: true, at: new Date().toISOString(), model: 'deterministic local fixture', background, followup, peak, turns, peerDelivery: true, reportsReturned: true, childPermissionsEnforced: true }, null, 2));
  console.log('PASS real SDK: two parallel agents, peer message delivery, parent result aggregation, scoped child permissions');
  }
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'sdk-collaboration-debug.json'), JSON.stringify({ turns, messages, requests, stderr }, null, 2));
  throw error;
} finally {
  releaseBoth(); peerSent();
  if (child.connected) child.send({ kind: 'stop' });
  child.kill(); child.stdout.destroy(); child.stderr.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('pp-collaboration-')) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
