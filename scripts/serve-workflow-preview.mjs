import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../artifacts/shared-skills/ram-report');
const port = Number(process.env.PROFILEPILOT_REPORT_PORT || 18765);
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };
http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
  let file;
  try { file = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1) || 'report.html'; } catch { response.writeHead(400); response.end(); return; }
  if (path.basename(file) !== file || !types[path.extname(file)]) { response.writeHead(404); response.end(); return; }
  try {
    const location = path.join(root, file);
    if (!statSync(location).isFile()) throw new Error('not a file');
    const content = readFileSync(location);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Price report: http://127.0.0.1:${port}/`));
