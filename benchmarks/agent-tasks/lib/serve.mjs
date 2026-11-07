import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWindowsCimInvocation, quoteWindowsArgument } from '../../../scripts/start-independent.mjs';

const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function serve({ run, port = 0, token = randomUUID() }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid preview port');
  const server = http.createServer(async (request, response) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://127.0.0.1').pathname; }
    catch { response.writeHead(400); response.end('Invalid request URL'); return; }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (pathname === '/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, pid: process.pid, token })); return; }
    // No private grader state, logs, agent files, or arbitrary file traversal.
    const filename = pathname === '/' || pathname === '/report.html' ? 'report.html' : pathname === '/report.json' ? 'report.json' : null;
    if (!filename) { response.writeHead(404); response.end('Not found'); return; }
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Type', filename.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
      response.end(await readFile(path.join(run, filename)));
    } catch { response.writeHead(404); response.end('Report unavailable'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const info = { pid: process.pid, url: `http://127.0.0.1:${server.address().port}/`, token, run };
  try { await writeFile(path.join(run, 'preview.json'), JSON.stringify(info, null, 2)); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  console.log(JSON.stringify(info));
  return { server, ...info };
}

export async function detachServer({ run, port = 0 }) {
  if (!port) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port');
  const token = randomUUID(), args = [runner, 'serve', '--run', run, '--port', String(port), '--token', token];
  if (process.platform === 'win32') {
    const literal = value => `'${String(value).replaceAll("'", "''")}'`;
    const bootstrapScript = `$ErrorActionPreference = 'Stop'\nStart-Process -FilePath ${literal(process.execPath)} -ArgumentList ${literal(args.map(quoteWindowsArgument).join(' '))} -WorkingDirectory ${literal(repo)} -WindowStyle Hidden`;
    const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const invocation = buildWindowsCimInvocation({ bootstrapScript, powershellPath });
    const result = spawnSync(invocation.executable, invocation.args, { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (result.error || result.status !== 0) throw Error(`Independent preview launch failed: ${result.error?.message || result.stderr}`);
  } else {
    const child = spawn(process.execPath, args, { cwd: repo, detached: true, stdio: 'ignore', shell: false });
    child.unref();
  }
  const url = `http://127.0.0.1:${port}/`;
  let info;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const health = await (await fetch(`${url}health`, { signal: AbortSignal.timeout(750) })).json(); if (health.token === token) { info = health; break; } } catch {}
    await pause(250);
  }
  if (!info) throw Error('Independent preview did not become ready');
  await pause(1000);
  const verified = await (await fetch(`${url}health`, { signal: AbortSignal.timeout(2000) })).json();
  if (verified.pid !== info.pid || verified.token !== token) throw Error('Independent preview did not remain alive');
  console.log(JSON.stringify({ url, pid: info.pid, independent: true, run }));
  return { url, pid: info.pid };
}
