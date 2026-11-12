import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'artifacts/impeccable/workspace-states');
await mkdir(root, { recursive: true });
for (const page of ['browser','settings','gpui','desktop','local-apps','phones']) {
  await build({ entryPoints:[path.join(repo,`src/renderer/${page==='browser'?'main':page}.ts`)],bundle:true,platform:'browser',target:'es2022',outfile:path.join(root,`${page}.js`) });
  let html = await readFile(path.join(repo,`public/${page==='browser'?'index':page}.html`),'utf8');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/href="\.\/([^"]+)"/g,(_,file)=>`href="${pathToFileURL(path.join(repo,'public',file))}"`);
  html = html.replace('<html lang="zh-CN">','<html lang="zh-CN" class="workspace-layout">').replace('</body>',`<script src="${page}.js"></script></body>`);
  await writeFile(path.join(root,`${page}.html`),html);
}
const child=spawn(require('electron'),[path.join(repo,'scripts/e2e/fixtures/workspace-states-main.cjs')],{cwd:repo,windowsHide:true,stdio:'pipe',env:{...process.env,WORKSPACE_REVIEW_ROOT:root}});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
