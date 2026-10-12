import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { BrowserGatewayDaemon } = require('../dist/main/browser-gateway-daemon.js');
const { requestBrowserGateway } = require('../dist/main/browser-gateway-client.js');
const { getDirectChromeCommand } = require('../dist/main/chrome-launch.js');
const executable = getDirectChromeCommand();
assert.ok(executable, 'Chrome must be installed');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-background-input-'));
const home = path.join(root, 'home');
await mkdir(home);
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const daemon = new BrowserGatewayDaemon(home);
const request = body => requestBrowserGateway(body, { homeDir: home, timeoutMs: 15000 });
const env = { ...process.env, HOME: home, PROFILEPILOT_GATEWAY_HOME: home, CPM_DATA_DIR: path.join(root, 'data'), AGENT_BROWSER_SOCKET_DIR: path.join(home, '.agent-browser') };
const prefix = [path.resolve('dist/main/profilepilot-cli.cjs'), 'browser', '--session', 'background-input-test', '--cdp', String(port)];
const samples = [];
async function command(...args) {
  const started = performance.now();
  const { stdout } = await promisify(execFile)(process.execPath, [...prefix, ...args, '--json'], { env, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.notEqual(result.ok, false); assert.notEqual(result.success, false);
  if (args[0] === 'mouse') samples.push({ command: args.join(' '), ms: Math.round(performance.now() - started) });
  return result.data || result.result || result;
}
const evaluate = async source => (await command('eval', '-b', Buffer.from(source).toString('base64'))).result;
try {
  await daemon.start();
  const launched = await request({ action: 'launch-profile', profileId: 'background-input-test', profileName: 'Background input test', publicPort: port, executable,
    // Only this disposable local test browser: an elevated Windows test runner
    // must retain the pipe when Chrome would otherwise relaunch de-elevated.
    args: [`--user-data-dir=${path.join(root, 'chrome')}`, '--no-first-run', '--no-default-browser-check', ...(process.platform === 'win32' ? ['--do-not-de-elevate'] : [])] });
  assert.equal(launched.ok, true);
  const html = `<body><div id="box" style="height:30px;width:30px;background:green"></div><textarea name="h-captcha-response"></textarea><script>
    window.events=[]; window.paint=null;
    for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,event=>{
      events.push({type:event.type,x:event.clientX,y:event.clientY,buttons:event.buttons,trusted:event.isTrusted});
      requestAnimationFrame(()=>{paint={x:event.clientX,y:event.clientY};box.style.transform='translate('+event.clientX+'px,'+event.clientY+'px)'});
    });
  </script>`;
  await command('open', 'data:text/html,' + encodeURIComponent(html));
  // The initial Chrome tab remains foreground; the Agent's new tab is hidden.
  await command('tab', 'new', 'data:text/html,' + encodeURIComponent(html));
  assert.equal(await evaluate('document.visibilityState'), 'hidden');
  const viewport = await evaluate('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})');
  await command('mouse', 'move', '100.4', '100.4');
  await command('mouse', 'down');
  for (let i = 1; i <= 8; i++) await command('mouse', 'move', String(100 + i * 12.5), String(100 + i * 12.5));
  await command('mouse', 'up');
  const state = await evaluate('({events,paint,visibility:document.visibilityState})');
  assert.equal(state.visibility, 'hidden', 'input must not activate the page');
  assert.deepEqual(await evaluate('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})'), viewport, 'frame pulses must not change viewport metrics');
  assert.deepEqual(state.paint, { x: 200, y: 200 }, 'rAF-rendered content must catch up without a dummy click');
  assert.equal(state.events.filter(e => e.type === 'pointerdown').length, 1);
  assert.equal(state.events.filter(e => e.type === 'pointerup').length, 1);
  assert.equal(state.events.filter(e => e.type === 'pointermove' && e.buttons === 1).length, 8);
  assert.ok(state.events.every(e => e.trusted));
  assert.ok(samples.every(s => s.ms < 2000), `input ACK regression: ${JSON.stringify(samples)}`);
  await evaluate(`setTimeout(()=>document.querySelector('textarea').value='local-fixture-response',700);true`);
  const response = await command('captcha', 'wait', '--timeout', '3000');
  assert.equal(response.status, 'response_present'); assert.equal(response.verified, false);
  assert.ok(!JSON.stringify(response).includes('local-fixture-response'));
  const report = { platform: process.platform, samples, state, response };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/background-input.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, platform: process.platform, maxCommandMs: Math.max(...samples.map(s => s.ms)), commands: samples.length, paint: state.paint, delayedResponse: response.status }));
  await command('complete');
} finally {
  await request({ action: 'unregister-profile', publicPort: port, closeChrome: true }).catch(() => {});
  await daemon.stop();
  const absolute = path.resolve(root), temporaryRoot = path.resolve(os.tmpdir());
  if (path.dirname(absolute) === temporaryRoot && path.basename(absolute).startsWith('pp-background-input-')) await rm(absolute, { recursive: true, force: true }).catch(() => {});
}
