// Real Chromium encoder/decoder smoke test. No phone, browser profile or network.
const electron = require('electron');
if (typeof electron === 'string') {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(electron, [__filename], { env: environment, windowsHide: true, stdio: 'inherit', timeout: 20000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, protocol } = electron;
protocol.registerSchemesAsPrivileged([{ scheme: 'phone-video-test', privileges: { standard: true, secure: true } }]);
const assert = require('node:assert/strict');
const { AnnexBVideo } = require('../dist/main/phones/screen-video');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 100, height: 180, webPreferences: { backgroundThrottling: false } });
  try {
    protocol.handle('phone-video-test', () => new Response('<canvas width="64" height="128"></canvas>', { headers: { 'content-type': 'text/html' } }));
    await window.loadURL('phone-video-test://fixture/');
    const chunks = await window.webContents.executeJavaScript(`(async () => {
      const chunks=[], canvas=document.querySelector('canvas'), context=canvas.getContext('2d'); let error;
      const encoder=new VideoEncoder({output:chunk=>{const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);chunks.push([...data]);},error:e=>error=e});
      const config={codec:'avc1.42001f',width:64,height:128,bitrate:200000,framerate:15,latencyMode:'realtime',avc:{format:'annexb'}};
      if(!(await VideoEncoder.isConfigSupported(config)).supported) throw Error('H.264 encoder unavailable in test runtime');
      encoder.configure(config);
      for(let i=0;i<12;i++){context.fillStyle=i%2?'#ff0000':'#00ff00';context.fillRect(0,0,64,128);const frame=new VideoFrame(canvas,{timestamp:i*66667});encoder.encode(frame,{keyFrame:i===0});frame.close();}
      await encoder.flush();encoder.close();if(error)throw error;return chunks;
    })()`);
    const packets = [], parser = new AnnexBVideo(packet => packets.push({ ...packet, data: [...packet.data] }));
    const bytes = Buffer.concat([...chunks.map(data => Buffer.from(data)), Buffer.from([0, 0, 0, 1, 9, 0xf0])]);
    for (let i = 0; i < bytes.length; i += 17) parser.push(bytes.subarray(i, i + 17));
    assert.equal(packets.length, 12, 'the parser must reconstruct every encoded picture');
    const decoded = await window.webContents.executeJavaScript(`(async () => {
      const pictures=[];let error;
      const decoder=new VideoDecoder({output:frame=>{pictures.push([frame.displayWidth,frame.displayHeight]);frame.close();},error:e=>error=e});
      decoder.configure({codec:${JSON.stringify(packets[0].codec)},optimizeForLatency:true,hardwareAcceleration:'prefer-hardware'});
      for(const packet of ${JSON.stringify(packets)})decoder.decode(new EncodedVideoChunk({type:packet.key?'key':'delta',timestamp:packet.timestamp,data:new Uint8Array(packet.data)}));
      await decoder.flush();decoder.close();if(error)throw error;return pictures;
    })()`);
    assert.deepEqual(decoded, Array.from({ length: 12 }, () => [64, 128]));
    console.log(JSON.stringify({ passed: true, encoded: chunks.length, parsed: packets.length, decoded: decoded.length, codec: packets[0].codec }));
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
