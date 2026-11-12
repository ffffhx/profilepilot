'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

function changeKind(file) {
  const name = file.replaceAll('\\', '/');
  if (name === 'public/app.css' || name.startsWith('public/phone-video/') || name.startsWith('public/vision/')) return null;
  if (name.startsWith('src/renderer/') || name.startsWith('public/') || name.startsWith('tailwind.')) return 'renderer';
  return 'backend';
}
function run(command, root, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
      {cwd: root, env: buildEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', bytes => log.write(bytes)); child.stderr.on('data', bytes => log.write(bytes));
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`开发构建失败 (${code})，详见 .tools/development-build.log`)));
  });
}
function buildEnvironment(environment = process.env) {
  const result = {...environment};
  const key = Object.keys(result).find(name => name.toLowerCase() === 'path') || 'PATH';
  result[key] = [...new Set((result[key] || '').split(path.delimiter).filter(value => value && fs.existsSync(value)))].join(path.delimiter);
  delete result.ELECTRON_RUN_AS_NODE;
  return result;
}
function install({app, webContents, root, onError = console.error}) {
  const directory = path.join(root, '.tools'); fs.mkdirSync(directory, {recursive: true});
  const receipt = path.join(directory, 'development-runtime.json');
  const log = fs.createWriteStream(path.join(directory, 'development-build.log'), {flags: 'a'});
  let timer, building = false, stopped = false;
  const pending = new Set(), watchers = [];
  async function rebuild() {
    if (building || stopped || !pending.size) return;
    building = true;
    const backend = pending.has('backend'); pending.clear();
    try {
      await run(backend ? 'npm run build' : 'npm run bundle:renderer && npm run build:css', root, log);
      if (stopped) return;
      if (pending.size) { if (backend) pending.add('backend'); return; }
      if (backend) { app.relaunch({args: [...process.argv.slice(1).filter(value => value !== '--background'), '--background']}); app.quit(); }
      else for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.getURL().startsWith('file:')) contents.reloadIgnoringCache();
      }
    } catch (error) { onError(error); }
    finally { building = false; if (stopped) log.end(); else if (pending.size) timer = setTimeout(rebuild, 500); }
  }
  for (const entry of ['src', 'public', 'native', 'skills', 'extensions', 'package.json', 'tailwind.config.cjs', 'tailwind.chat.config.cjs']) {
    const target = path.join(root, entry);
    if (!fs.existsSync(target)) continue;
    const directoryEntry = fs.statSync(target).isDirectory();
    watchers.push(fs.watch(target, {recursive: directoryEntry}, (_event, name) => {
      if (directoryEntry && !name) return;
      const file = directoryEntry ? `${entry}/${name || ''}` : entry;
      // Windows reports parent-directory metadata changes alongside file writes.
      // Those events must not turn a renderer save into a backend restart.
      try { if (fs.statSync(path.join(root, file)).isDirectory()) return; } catch { /* A removed source file still needs a build. */ }
      const kind = changeKind(file);
      if (!kind || stopped) return;
      pending.add(kind); clearTimeout(timer); timer = setTimeout(rebuild, 700);
    }));
  }
  fs.writeFileSync(receipt, JSON.stringify({pid: process.pid, root: path.resolve(root), startedAt: new Date().toISOString()}));
  function close() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); for (const watcher of watchers) watcher.close();
    // A build already in flight can still write output while shutdown drains it.
    if (building) log.on('error', () => {});
    else log.end();
    try { if (JSON.parse(fs.readFileSync(receipt, 'utf8')).pid === process.pid) fs.rmSync(receipt); } catch {}
  }
  app.once('before-quit', close);
  return {close};
}
module.exports = {changeKind, install, buildEnvironment};
