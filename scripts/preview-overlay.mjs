import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { agentOverlayBootstrapScript } = require('../dist/main/overlay-script.js');
const port = Number(process.env.PP_OVERLAY_PREVIEW_PORT || 4318);
const states = {
  active: {},
  taken: { ownership: 'agentDelegatedToUser' },
  attention: { ownership: 'agentDelegatedToUser', pendingUserAction: '请先完成网页中的操作，再交还控制权。' },
  offline: { ownership: 'agentDelegatedToUser', agentOffline: true },
  reconnecting: { driverReconnecting: true },
  pending: { handoffPending: true },
  error: { ownership: 'agentDelegatedToUser', stopError: 'Agent 尚未等待接收控制权，请稍后重试。' }
};

// Preview uses the production bootstrap and simulated callbacks only. It never
// connects to a Profile, native input guard, or real Agent session.
const runtime = `
const stateName = new URLSearchParams(location.search).get('state') || 'active';
const samples = ${JSON.stringify(states)};
const originalAttach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(options) {
  const root = originalAttach.call(this, options);
  if (this.id === '__pp-agent-overlay') window.previewRoot = root;
  return root;
};
window.previewSignals = [];
let current = { locale: 'zh', session: 'preview-only', inputGuardState: 'active', ...(samples[stateName] || {}) };
window.__ppAgentOverlaySignal = (input) => {
  const action = JSON.parse(input);
  window.previewSignals.push(action);
  if (action.action === 'resume') current = { locale: 'zh', session: 'preview-only', inputGuardState: 'active' };
  if (action.reason === 'user_takeover') current = { ...current, ownership: 'agentDelegatedToUser', pendingUserAction: '' };
  if (action.reason !== 'user_stop') window.__ppAgentOverlayUpdate(current);
};
${agentOverlayBootstrapScript().replace('if (window.top !== window.self)', 'if (false /* preview samples intentionally use iframes */)')}
window.__ppAgentOverlayUpdate(current);
Element.prototype.attachShadow = originalAttach;
window.previewUpdate = (payload) => {
  current = { locale: 'zh', session: 'preview-only', inputGuardState: 'active', ...payload };
  window.__ppAgentOverlayUpdate?.(current);
};
setInterval(() => window.__ppAgentOverlayUpdate?.(current), 15000);
`;

const cards = [
  ['active', '操作中', '随时接管，开始手动操作'],
  ['taken', '已接管', '操作完成后，可交还控制权'],
  ['attention', '等待操作', '需要你参与时，用琥珀色提示'],
  ['offline', '已离线', '仍可通过更多操作结束任务']
].map(([state, title, detail]) => `<article><h2>${title}</h2><p>${detail}</p><iframe title="${title}预览" src="/frame?state=${state}"></iframe></article>`).join('');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProfilePilot · 单行控制条</title><link rel="stylesheet" href="/preview.css"><body><main><header><div><p class="eyebrow">PROFILEPILOT / UI 02</p><h1>始终一行，保持轻巧。</h1><p>这是实际组件，可直接点击接管、交还和更多操作。</p></div><button id="theme">切换深色</button></header><section>${cards}</section><footer><span>340 × 44 px · 所有状态保持相同尺寸</span><button id="reset">重置预览</button></footer><p class="note">预览中的操作仅用于体验，不会影响正在运行的任务。</p></main><script src="/preview.js"></script></body></html>`;
const css = `*{box-sizing:border-box}body{margin:0;background:#f6f6f4;color:#252827;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}main{max-width:980px;margin:48px auto;padding:0 32px}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dfe2df;padding-bottom:28px;gap:24px}.eyebrow{font-size:11px;letter-spacing:2px;color:#747b76}h1{margin:10px 0;font-size:30px;font-weight:600;letter-spacing:-.7px}p{color:#747b76;margin:6px 0}section{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:30px 0}article{padding:12px 0}h2{font-size:15px;font-weight:600;margin:0 0 4px}article p{font-size:12px}iframe{display:block;width:100%;height:94px;border:0;margin-top:8px;border-radius:12px;background:#eceeeb}button{font:inherit;background:transparent;border:1px solid #dfe2df;color:inherit;border-radius:8px;padding:7px 12px;cursor:pointer}button:hover{background:#eceeeb}footer{display:flex;align-items:center;justify-content:space-between;border-top:1px solid #dfe2df;padding-top:22px;font-size:12px;color:#747b76}.note{font-size:12px;margin-top:16px}@media(max-width:790px){main{max-width:460px;margin:24px auto;padding:0 16px}section{grid-template-columns:1fr;gap:8px}h1{font-size:23px}header{align-items:flex-start}header button{white-space:nowrap}}`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const send = (type, body) => {
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(body);
  };
  if (url.pathname === '/') return send('text/html', html);
  if (url.pathname === '/preview.css') return send('text/css', css);
  if (url.pathname === '/preview.js') return send('text/javascript', `let dark=false;const frames=[...document.querySelectorAll('iframe')];document.querySelector('#theme').onclick=()=>{dark=!dark;for(const f of frames){const u=new URL(f.src);u.searchParams.set('theme',dark?'dark':'light');f.src=u.href}document.querySelector('#theme').textContent=dark?'切换浅色':'切换深色'};document.querySelector('#reset').onclick=()=>frames.forEach(f=>f.src=f.src);`);
  if (url.pathname === '/frame') {
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; require-trusted-types-for 'script'");
    return send('text/html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>控制条预览</title><link rel="stylesheet" href="/frame.css?theme=${url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'}"><body><script src="/runtime.js"></script></body></html>`);
  }
  if (url.pathname === '/frame.css') return send('text/css', `html,body{margin:0;background:${url.searchParams.get('theme') === 'dark' ? '#181b1c' : '#eceeeb'};min-height:100%;}`);
  if (url.pathname === '/runtime.js') return send('text/javascript', runtime);
  response.writeHead(404).end();
});
server.listen(port, '127.0.0.1', () => console.log(`Overlay preview: http://127.0.0.1:${port} (PID ${process.pid})`));
