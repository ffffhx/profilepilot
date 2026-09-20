import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsRoot = path.resolve(repo, '../garden-lab/apps/browser-tool-bench/results');
const entries = (await readdir(resultsRoot)).filter(n => n.startsWith('jev-core-')).sort();
const root = path.resolve(resultsRoot, process.argv[2] || entries.at(-1) || 'missing');
if (!root.startsWith(resultsRoot + path.sep)) throw new Error('Report path is outside results.');
await stat(path.join(root, 'manifest.json'));
http.createServer(async (req, res) => {
  try {
    const route = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : route));
    if (!file.startsWith(root + path.sep) || !/\.(html|json|md|png)$/.test(file)) { res.writeHead(404).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html;charset=utf-8' : file.endsWith('.json') ? 'application/json;charset=utf-8' : file.endsWith('.png') ? 'image/png' : 'text/plain;charset=utf-8', 'cache-control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(4401, '127.0.0.1', () => console.log('Jev benchmark report: http://127.0.0.1:4401/'));
