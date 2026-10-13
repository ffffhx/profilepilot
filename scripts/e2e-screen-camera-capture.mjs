import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.versions.electron) {
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], { cwd: root, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { throw error; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, nativeImage } = require('electron');
  const { desktopCameraCapture } = require('../dist/main/phones/screen-camera-capture.js');
  const output = path.join(root, 'artifacts/screen-camera'); mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, 'capture-test-electron'));
  app.on('window-all-closed', () => {}); // Keep the closed-source assertion alive.
  void app.whenReady().then(async () => {
  let window;
  try {
    const title = `ProfilePilot camera capture fixture ${process.pid}`;
    window = new BrowserWindow({ width: 400, height: 400, frame: false, show: false, resizable: false, webPreferences: { sandbox: true } });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<title>${title}</title><body style="margin:0;display:flex;height:100vh"><div style="width:50%;background:rgb(230,20,20)"></div><div style="width:50%;background:rgb(20,40,230)"></div></body>`));
    window.showInactive();
    const capture = desktopCameraCapture(); let source;
    for (let attempt = 0; attempt < 20; attempt++) {
      source = (await capture.sources()).find(item => item.name === title);
      if (source) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(source, 'The real desktop source must contain our disposable window');
    const frame = Buffer.from(await capture.capture(source.id, { x: .55, y: .1, width: .4, height: .8 }), 'base64');
    const image = nativeImage.createFromBuffer(frame), size = image.getSize(), pixels = image.toBitmap();
    const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
    // NativeImage's bitmap is BGRA on the supported little-endian desktop platforms.
    assert.ok(pixels[offset] > 190 && pixels[offset + 2] < 70, 'Normalized crop must select the blue right half');
    assert.ok(Math.abs(size.width / size.height - .5) < .03, 'The crop must preserve the selected aspect ratio');
    writeFileSync(path.join(output, 'desktop-capture-crop.jpg'), frame);
    window.destroy(); window = undefined;
    await assert.rejects(capture.capture(source.id), /关闭|无法采集/, 'Closed sources must not silently fall back to another window');
    console.log('PASS: real desktop window capture, normalized crop, color/aspect preservation and closed-source rejection. Android camera is not exercised.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); app.exit(process.exitCode || 0); }
  });
}
