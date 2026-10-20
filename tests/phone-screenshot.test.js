const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { captureAdbScreen, inspectScreenPng } = loadCli('src/main/phones/screenshot.ts');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAuSURBVEhLY0iZ+vb/QGIGdAF641EHjDpg1AGjDhh1wKgDRh0w6oBRB4w6YNQBABY2r3kHmyLXAAAAAElFTkSuQmCC', 'base64');

test('PNG validation requires complete chunks, valid checksums and the final IEND', () => {
  assert.deepEqual(inspectScreenPng(png), {width:32,height:24,complete:true});
  for (const length of [33, 50, png.length-12, png.length-1])
    assert.equal(inspectScreenPng(png.subarray(0,length)).complete,false);
  const corrupt=Buffer.from(png);corrupt[100]^=1;
  assert.throws(()=>inspectScreenPng(corrupt),/有效画面/);
  assert.throws(()=>inspectScreenPng(Buffer.concat([png,Buffer.from('extra')])),/有效画面/);
});

test('truncated emulator stream uses a fresh file capture and removes only its own temporary files', async () => {
  const calls=[],abort=new AbortController();let local,remote;
  const adb={
    runBinary:async args=>{calls.push(args);return png.subarray(0,-12);},
    run:async args=>{
      calls.push(args);
      if(args[2]==='pull'){remote=args[3];local=args[4];fs.writeFileSync(local,png);}
      return '';
    }
  };
  const frame=await captureAdbScreen(adb,'emulator-test',abort.signal,()=>{});
  assert.deepEqual(frame,{png,width:32,height:24});
  assert.match(remote,/^\/data\/local\/tmp\/ppilot-screen-[a-f0-9-]+\.png$/);
  assert.equal(calls.filter(a=>a.includes('exec-out')).length,1);
  assert.ok(calls.some(a=>a[3]===`'screencap' '-p' '${remote}'`));
  assert.equal(calls.at(-1)[3],`'rm' '-f' '${remote}'`);
  assert.equal(fs.existsSync(path.dirname(local)),false);
  const previousRemote=remote;
  assert.deepEqual(await captureAdbScreen(adb,'emulator-test',abort.signal,()=>{}),frame);
  assert.equal(calls.filter(a=>a.includes('exec-out')).length,1,'known truncated stream does not waste a capture on every frame');
  assert.notEqual(remote,previousRemote);
  assert.equal(fs.existsSync(path.dirname(local)),false);
});

test('ownership change during fallback discards the frame and sends no more device commands', async () => {
  const calls=[],abort=new AbortController();let owned=true,local;
  const adb={
    runBinary:async()=>png.subarray(0,-12),
    run:async args=>{
      calls.push(args);
      if(args[2]==='pull'){local=args[4];fs.writeFileSync(local,png);owned=false;}
      return '';
    }
  };
  await assert.rejects(captureAdbScreen(adb,'emulator-test',abort.signal,()=>{if(!owned)throw Error('ownership changed');}),/ownership/);
  assert.equal(calls.length,2);
  assert.equal(fs.existsSync(path.dirname(local)),false);
});

test('failed fallback cannot return an incomplete frame and still cleans up while owned', async () => {
  const calls=[],abort=new AbortController();let local;
  const adb={runBinary:async()=>png.subarray(0,-12),run:async args=>{
    calls.push(args);if(args[2]==='pull'){local=args[4];fs.writeFileSync(local,png.subarray(0,-12));}return '';
  }};
  await assert.rejects(captureAdbScreen(adb,'emulator-test',abort.signal,()=>{}),/有效画面/);
  assert.match(calls.at(-1)[3],/^'rm' '-f'/);
  assert.equal(fs.existsSync(path.dirname(local)),false);
});
