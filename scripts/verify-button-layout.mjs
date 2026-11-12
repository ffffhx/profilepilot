import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'artifacts', 'button-layout');
await mkdir(root, { recursive: true });
const labels = new Map();
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { await scan(filename); continue; }
    if (!filename.endsWith('.ts')) continue;
    const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'renderButtonLabel' && node.arguments.length >= 3) {
        const [,idle,active] = node.arguments;
        if (ts.isStringLiteral(idle) && ts.isStringLiteral(active)) labels.set(`${idle.text}|${active.text}`, [idle.text,active.text]);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
await scan(path.join(repo, 'src', 'renderer'));
await writeFile(path.join(root, 'labels.json'), JSON.stringify([...labels.values()]));
await build({ entryPoints: [path.join(repo, 'scripts/e2e/fixtures/button-layout.ts')], bundle: true, outfile: path.join(root, 'fixture.js'), platform: 'browser', target: 'es2022' });
const styles = ['app.css','workspace-switcher.css','window-chrome.css','design-system.css','browser-design.css','pc-control.css','tools-design.css'];
await writeFile(path.join(root, 'index.html'), `<!doctype html><html class="workspace-layout"><head><meta charset="UTF-8">${styles.map(file=>`<link rel="stylesheet" href="${pathToFileURL(path.join(repo,'public',file))}">`).join('')}</head><body><div id="app"></div><script src="fixture.js"></script></body></html>`);
for (const page of ['settings','gpui','desktop','local-apps','phones']) {
  await build({ entryPoints: [path.join(repo, page === 'phones' ? 'scripts/e2e/fixtures/phone-button-layout.ts' : `src/renderer/${page}.ts`)], bundle:true, outfile:path.join(root,`${page}.js`), platform:'browser', target:'es2022' });
  let html=await readFile(path.join(repo,`public/${page}.html`),'utf8');
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/href="\.\/([^"]+)"/g,(_,file)=>`href="${pathToFileURL(path.join(repo,'public',file))}"`);
  html=html.replace('<html lang="zh-CN">','<html lang="zh-CN" class="workspace-layout">').replace('</body>',`<script src="${page}.js"></script></body>`);
  await writeFile(path.join(root,`${page}.html`),html);
}
async function run(file) {
  const child=spawn(require('electron'),[path.join(repo,'scripts/e2e/fixtures',file)],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BUTTON_LAYOUT_FIXTURE:root}});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}
const components=await run('button-layout-main.cjs');
const pages=await run('button-pages-main.cjs');
process.exitCode = components || pages;
