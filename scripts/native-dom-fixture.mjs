import http from 'node:http';

export async function startNativeDomFixture() {
  const hits = [], requests = [], windowReports = [];
  let port;
  const app = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    requests.push(url.pathname);
    if (url.pathname === '/hit') { hits.push(Object.fromEntries(url.searchParams)); res.end('ok'); return; }
    if (url.pathname === '/window-report') { windowReports.push(Object.fromEntries(url.searchParams)); res.end('ok'); return; }
    if (url.pathname === '/redirect') { res.writeHead(302, { Location: '/file' }); res.end(); return; }
    if (url.pathname === '/file') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="same-report.csv"; filename*=UTF-8''same-report.csv` });
      res.end('id,value\n1,native-dom-fixture\n'); return;
    }
    if (url.pathname === '/slow') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="slow.txt"', 'Content-Length': '1048576' });
      res.write('begin');
      const timer = setInterval(() => res.write('chunk'), 500); req.on('close', () => clearInterval(timer)); return;
    }
    if (url.pathname === '/delayed') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="delayed-fixture.txt"', 'Content-Length': '15' });
      res.write('delayed-'); setTimeout(() => res.end('fixture'), 1000); return;
    }
    if (url.pathname === '/broken') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="broken.txt"', 'Content-Length': '99999' });
      res.write('partial'); setTimeout(() => res.destroy(), 200); return;
    }
    const a = `http://127.0.0.1:${port}`, b = `http://127.0.0.2:${port}`;
    const frame = url.pathname === '/child' ? 'child' : url.pathname === '/grandchild' ? 'grandchild' : url.pathname === '/same' ? 'same' : 'root';
    const shadow = `<div id="shadow-host"></div><script>
      const s=document.querySelector('#shadow-host').attachShadow({mode:'open'});s.innerHTML='<span>SHADOW_TEXT_${frame}</span><div id="nested"></div>';
      const deep=s.querySelector('#nested').attachShadow({mode:'open'});deep.innerHTML='<button id="deep">Deep shadow ${frame}</button><input aria-label="Shadow input ${frame}">';
      deep.querySelector('button').onclick=()=>fetch('/hit?frame=${frame}&action=shadow');
    </script>`;
    const form = `<form onsubmit="event.preventDefault();fetch('/hit?frame=${frame}&action=submit&first='+encodeURIComponent(this.first.value)+'&second='+encodeURIComponent(this.second.value));document.querySelector('#receipt').textContent='SAVED_${frame}'">
      <label>First ${frame}<input name="first"></label><label>Second ${frame}<textarea name="second"></textarea></label>
      <select aria-label="Choice ${frame}">${Array.from({ length: 130 }, (_, i) => `<option value="v${i}">Option ${i}</option>`).join('')}</select>
      <label>File ${frame}<input type="file" onchange="document.querySelector('#receipt').textContent=this.files[0].name"></label>
      <button type="submit">Save ${frame}</button><p id="receipt"></p></form>`;
    const downloads = `<a href="/redirect?keep=query" download>Download redirect ${frame}</a>
      <button onclick="const a=document.createElement('a');a.href='/file?js=${frame}';a.download='';a.click()">Download JS ${frame}</button>
      <button onclick="const a=document.createElement('a');a.href='/delayed';a.download='';a.click()">Download delayed ${frame}</button>
      <button onclick="fetch('/hit?frame=${frame}&action=blob-handler-start');try{const a=document.createElement('a');a.href=globalThis.URL.createObjectURL(new globalThis.Blob(['blob-fixture'],{type:'text/plain'}));a.download='blob.txt';a.click();fetch('/hit?frame=${frame}&action=blob-handler-end&url='+encodeURIComponent(a.href)+'&activation='+navigator.userActivation.isActive)}catch(error){fetch('/hit?frame=${frame}&action=blob-handler-error&error='+encodeURIComponent(error.stack||error.message))}">Download blob ${frame}</button>`;
    if (url.pathname === '/blob-only') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>Blob download fixture</title><body>' + downloads.slice(downloads.indexOf('<button onclick="fetch(')) + '</body>'); return;
    }
    const frames = frame === 'root' ? `<iframe title="Same process" src="${a}/same"></iframe><iframe title="Cross site" src="${b}/child"></iframe>` : frame === 'child' ? `<iframe title="Nested cross site" src="${a}/grandchild"></iframe>` : '';
    const long = frame === 'root' ? `<p>${'LONG_PAGE_CONTENT '.repeat(1800)}END_OF_LONG_PAGE</p>${Array.from({ length: 240 }, (_, i) => `<button onclick="fetch('/hit?frame=root&action=long-${i}')">Long control ${i}</button>`).join('')}` : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html><head><title>DOM fixture ${frame}</title><style>body{font:16px sans-serif}iframe{width:650px;height:480px;display:block;margin:20px;border:4px solid #888}button,input,select,textarea{margin:6px;padding:6px}canvas{border:1px solid}</style></head><body><h1>${frame}</h1>${form}${shadow}${downloads}<canvas width="200" height="80" aria-label="Canvas ${frame}" onclick="fetch('/hit?frame=${frame}&action=canvas')"></canvas>${frames}${long}<script>document.addEventListener('pointerdown',e=>fetch('/hit?frame=${frame}&action=pointerdown&target='+e.target.tagName+'&text='+encodeURIComponent(e.target.textContent?.slice(0,50))+'&x='+e.clientX+'&y='+e.clientY),true)</script></body></html>`);
  });
  await new Promise(resolve => app.listen(0, '0.0.0.0', resolve));
  port = app.address().port;
  return { url: `http://127.0.0.1:${port}`, hits, requests, windowReports, close: async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); } };
}
