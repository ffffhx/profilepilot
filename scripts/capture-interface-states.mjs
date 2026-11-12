import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo,'artifacts','impeccable','interface-states');
await mkdir(root,{recursive:true});
await build({entryPoints:[path.join(repo,'scripts/e2e/fixtures/interface-states.ts')],bundle:true,platform:'browser',target:'es2022',outfile:path.join(root,'fixture.js')});
const styles=['app.css','workspace-switcher.css','window-chrome.css','design-system.css','browser-design.css','pc-control.css','tools-design.css'];
await writeFile(path.join(root,'index.html'),`<!doctype html><html lang="zh-CN" class="workspace-layout"><head><meta charset="UTF-8">${styles.map(file=>`<link rel="stylesheet" href="${pathToFileURL(path.join(repo,'public',file))}">`).join('')}</head><body><div id="app"></div><script src="fixture.js"></script></body></html>`);
const child=spawn(require('electron'),[path.join(repo,'scripts/e2e/fixtures/interface-states-main.cjs')],{cwd:repo,windowsHide:true,stdio:'pipe',env:{...process.env,INTERFACE_REVIEW_ROOT:root,INTERFACE_REVIEW_PHASE:process.argv.includes('--before')?'before':'after'}});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
