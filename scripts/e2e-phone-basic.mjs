import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {ElectronDriver,delay,repoRoot,launchProfilePilotE2e} from './e2e/lib/electron-driver.mjs';
const require=createRequire(import.meta.url);
const fixture=await mkdtemp(path.join(os.tmpdir(),'pp-phone-basic-ui-'));
const socket=process.platform==='win32'?`\\\\.\\pipe\\pp-phone-basic-${process.pid}`:path.join(fixture,'driver.sock');
const child=spawn(require('electron'),[path.join(repoRoot,'scripts/e2e/fixtures/phone-ui-main.cjs')],{cwd:repoRoot,windowsHide:true,env:{...process.env,PHONE_UI_FIXTURE:fixture,PHONE_UI_SOCKET:socket,PHONE_UI_NO_APP:'1'},stdio:['ignore','pipe','pipe']});
let driver,logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
try {
  for(let i=0;i<200;i++){
    if(child.exitCode!==null)throw new Error(logs);
    try{driver=new ElectronDriver(await new Promise((resolve,reject)=>{const c=net.createConnection(socket);c.once('connect',()=>resolve(c));c.once('error',e=>{c.destroy();reject(e);});}));break;}catch{await delay(50);}
  }
  assert.ok(driver,logs);
  const state=()=>driver.evaluate('window.phones.snapshot()');
  const calls=()=>driver.evaluate('window.phoneBasicFixture.calls()');
  await driver.waitFor('[data-action="basic-control"]');
  assert.equal((await state()).devices[0].state,null,'fixture starts without App pairing');
  assert.equal((await driver.query('[data-action="basic-view"]')).count,0,'only one basic-control entry');
  assert.equal((await driver.query('[data-app-installation]')).attributes['data-app-installation'],'missing');
  assert.equal(await driver.evaluate('document.querySelector(".phone-connection-section").getBoundingClientRect().bottom < document.querySelector(".phone-basic-section").getBoundingClientRect().top'),true);
  assert.equal(await driver.evaluate('[...document.querySelectorAll(".phone-permissions .phone-setting")].every(row=>row.getBoundingClientRect().height>0)'),true,'permissions visible without opening details');
  await driver.domClick('[data-action="inspect-app"]');
  await driver.waitFor('[data-action="inspect-app"]',x=>!x.disabled);
  assert.equal((await state()).devices[0].appInstallation.status,'missing');
  const output=path.join(repoRoot,'artifacts/phone-basic');await mkdir(output,{recursive:true});
  assert.equal(await driver.evaluate('document.querySelector(".phone-basic-section").getBoundingClientRect().bottom < document.querySelector(".phone-enhanced-section").getBoundingClientRect().top'),true);
  assert.equal(await driver.evaluate('(async()=>{const img=document.querySelector(".phone-download-qr img");await img.decode();return img.naturalWidth>0;})()'),true);
  assert.equal(await driver.evaluate('document.querySelector("[data-phone-app-setup]").closest(".phone-enhanced-section") !== null'),true);
  await driver.domClick('[data-action="phone-apk"]');
  await driver.waitFor('#phone-message',x=>/APK/.test(x.text));
  await writeFile(path.join(output,'modes-and-download.png'),Buffer.from((await driver.screenshot()).pngBase64,'base64'));
  await driver.request('resize',{width:760,height:900});
  await driver.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  assert.equal(await driver.evaluate('(()=>{const section=document.querySelector(".phone-enhanced-section");return section.scrollWidth<=section.clientWidth+1;})()'),true,'downloads fit a narrow window');
  await writeFile(path.join(output,'modes-narrow.png'),Buffer.from((await driver.screenshot()).pngBase64,'base64'));
  await driver.request('resize',{width:1440,height:1080});
  await driver.domClick('[data-action="basic-control"]');
  await driver.waitFor('.phone-basic-dialog[open] .phone-basic-screen img',x=>x.attributes['data-interactive']==='true');
  await driver.domInput('.phone-basic-auto input','',{checked:false});
  assert.equal((await state()).devices[0].basic.phase,'controlling');
  assert.equal((await calls()).some(a=>a.includes('install')),false);
  assert.equal((await driver.query('[data-basic-text], .phone-basic-dialog input[name="text"]')).count,0);
  // An automatic read must retain the image node and avoid busy-label/opacity
  // flashes. Identical pixels need no DOM replacement at all.
  await driver.evaluate(`window.firstPhoneImage=document.querySelector('.phone-basic-screen img');
    window.phoneRefreshMutations=0;
    window.phoneRefreshObserver=new MutationObserver(records=>window.phoneRefreshMutations+=records.length);
    window.phoneRefreshObserver.observe(document.querySelector('.phone-basic-status'),{childList:true,subtree:true});
    window.phoneRefreshObserver.observe(document.querySelector('.phone-basic-screen'),{childList:true}); true`);
  const beforeRefresh=(await calls()).filter(a=>a.includes('screencap')).length;
  await driver.domInput('.phone-basic-auto input','',{checked:true});
  await delay(2300);
  await driver.domInput('.phone-basic-auto input','',{checked:false});
  await driver.waitFor('.phone-basic-screen',x=>x.attributes['aria-busy']==='false');
  assert.ok((await calls()).filter(a=>a.includes('screencap')).length>beforeRefresh);
  assert.equal(await driver.evaluate('window.phoneRefreshMutations'),0,'static screen refresh does not repaint the image or status label');
  assert.equal(await driver.evaluate('window.firstPhoneImage===document.querySelector(".phone-basic-screen img")'),true);
  await driver.evaluate('window.phoneRefreshObserver.disconnect(); true');
  // Hold decoding of a changed landscape frame. The old frame must remain
  // visible until the new image is completely ready, with steady controls.
  const holdDecode=async()=>driver.evaluate(`window.savedPhoneDecode=HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode=function(){return window.savedPhoneDecode.call(this).then(()=>new Promise(resolve=>{window.releasePhoneDecode=resolve;document.querySelector('.phone-basic-screen').dataset.decoded='true';}));}; true`);
  const releaseDecode=async()=>driver.evaluate(`HTMLImageElement.prototype.decode=window.savedPhoneDecode;
    delete document.querySelector('.phone-basic-screen').dataset.decoded;window.releasePhoneDecode(); true`);
  await holdDecode();
  await driver.evaluate('window.phoneBasicFixture.frame({width:640,height:320,shade:200,delay:250})');
  await driver.domClick('[data-basic-refresh]');
  await driver.waitFor('.phone-basic-screen',x=>x.attributes['data-decoded']==='true');
  assert.equal(await driver.evaluate('window.firstPhoneImage.isConnected && !window.firstPhoneImage.hidden && window.firstPhoneImage.complete'),true);
  assert.equal(await driver.evaluate('getComputedStyle(document.querySelector("[data-basic-key=home]")).opacity'),'1');
  assert.equal((await driver.query('[data-basic-key="home"]')).disabled,true,'refresh input remains serialized');
  assert.equal((await driver.query('.phone-basic-status')).text,'可以操作');
  await releaseDecode();
  await driver.waitFor('.phone-basic-screen',x=>x.attributes['aria-busy']==='false');
  assert.equal(await driver.evaluate('document.querySelector(".phone-basic-screen img").naturalWidth'),640);
  assert.equal(await driver.evaluate('window.firstPhoneImage.isConnected'),false);
  // A decode failure or a pause during decode cannot blank or replace the last
  // good frame, and a paused generation must never regain input authority.
  await driver.evaluate('window.lastPhoneImage=document.querySelector(".phone-basic-screen img");window.phoneBasicFixture.frame({corrupt:true})');
  await driver.domClick('[data-basic-refresh]');
  await driver.waitFor('.phone-basic-screen',x=>x.attributes['aria-busy']==='false');
  assert.equal(await driver.evaluate('window.lastPhoneImage.isConnected && !window.lastPhoneImage.hidden'),true);
  assert.ok((await driver.query('.phone-basic-error')).text);
  await holdDecode();
  await driver.evaluate('window.phoneBasicFixture.frame({shade:240})');
  await driver.domClick('[data-basic-refresh]');
  await driver.waitFor('.phone-basic-screen',x=>x.attributes['data-decoded']==='true');
  await driver.domClick('[data-basic-pause]');
  await driver.waitFor('.phone-basic-status',x=>x.text==='已暂停');
  await releaseDecode();
  await driver.waitFor('.phone-basic-screen',x=>x.attributes['aria-busy']==='false');
  assert.equal(await driver.evaluate('window.lastPhoneImage.isConnected'),true,'late decoded frame is discarded after pause');
  assert.equal((await driver.query('.phone-basic-screen img')).attributes['data-interactive'],'false');
  await driver.domClick('[data-basic-pause]');
  await driver.waitFor('.phone-basic-screen img',x=>x.attributes['data-interactive']==='true');
  await driver.click('.phone-basic-screen img');
  await driver.waitFor('.phone-basic-screen img',x=>x.attributes['data-interactive']==='true');
  assert.ok((await calls()).some(a=>a[3]?.startsWith("'input' 'tap'")));
  const bounds=await driver.evaluate('(()=>{const r=document.querySelector(".phone-basic-screen img").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height*.75};})()');
  await driver.drag('.phone-basic-screen img',bounds.x,bounds.y);
  await driver.waitFor('.phone-basic-screen img',x=>x.attributes['data-interactive']==='true');
  assert.ok((await calls()).some(a=>a[3]?.startsWith("'input' 'swipe'")));
  await driver.domClick('[data-basic-key="home"]');
  await driver.waitFor('.phone-basic-screen img',x=>x.attributes['data-interactive']==='true');
  await driver.domClick('[data-basic-pause]');
  await driver.waitFor('.phone-basic-status',x=>x.text==='已暂停');
  assert.equal((await driver.query('[data-basic-key="home"]')).disabled,true);
  const before=(await calls()).length;await delay(100);assert.equal((await calls()).length,before);
  await driver.domClick('[data-basic-pause]');
  await driver.waitFor('.phone-basic-screen img',x=>x.attributes['data-interactive']==='true');
  await writeFile(path.join(output,'control.png'),Buffer.from((await driver.screenshot()).pngBase64,'base64'));
  await driver.domClick('[data-basic-install]');
  await driver.waitFor('.phone-basic-dialog',x=>!x.exists);
  await driver.waitFor('#phone-message',x=>/App 已安装/.test(x.text));
  assert.equal((await state()).devices[0].basic.phase,'stopped');
  assert.equal((await calls()).filter(a=>a.includes('install')).length,1);
  await driver.evaluate('window.phones.basicStart(document.querySelector("[name=phoneDevice]").value, "view", "UI test", "Read-only session")');
  await driver.domClick('[data-action="basic-open"]');
  await driver.waitFor('.phone-basic-dialog[open]');
  assert.equal((await driver.query('[data-basic-key="home"]')).disabled,true);
  await driver.domClick('[data-basic-close]');
  await driver.waitFor('.phone-basic-dialog',x=>!x.exists);
  // Wi-Fi debugging without App pairing must replace the disconnected USB
  // selection and enable these buttons, even after basic control has ended.
  await driver.evaluate('window.phoneFixture.setConnection(false)');
  await driver.waitFor('[data-action="basic-control"]',x=>!x.disabled);
  assert.equal(await driver.evaluate('document.querySelector("[name=phoneDevice]").value'),'192.168.1.9:40236');
  assert.match((await driver.query('[data-route="wifi"] .phone-route-badge')).text,/已连接/);
  assert.equal((await driver.query('[data-action="install-phone-app"]')).disabled,false);
  await driver.evaluate('window.phones.basicStart(document.querySelector("[name=phoneDevice]").value, "view", "UI test", "Read-only session")');
  await driver.domClick('[data-action="basic-open"]');
  await driver.waitFor('.phone-basic-status',x=>x.text==='仅查看');
  assert.equal(await driver.evaluate('!document.querySelector(".phone-basic-screen img").hidden'),true);
  assert.equal((await state()).devices.find(d=>d.id==='192.168.1.9:40236').basic.phase,'viewing');
  await driver.domClick('[data-basic-close]');await driver.waitFor('.phone-basic-dialog',x=>!x.exists);
  await driver.domClick('[data-action="basic-control"]');await driver.waitFor('.phone-basic-dialog[open]');
  await driver.evaluate('window.phoneFixture.setOffline()');
  await driver.waitFor('.phone-basic-status',x=>x.text.includes('断开'));
  assert.equal((await driver.query('[data-basic-refresh]')).disabled,true);
  await driver.domClick('[data-basic-close]');await driver.waitFor('.phone-basic-dialog',x=>!x.exists);
  assert.equal((await driver.query('[data-action="basic-control"]')).disabled,true);
  assert.match((await driver.query('#phone-mode-hint')).text,/请先在上方/);
  assert.equal((await driver.query('[data-action="phone-apk"]')).disabled,false,'APK export stays available while offline');
  assert.equal((await driver.query('[data-action="phone-download-copy"]')).disabled,false,'download URL stays available while offline');
  console.log('Basic phone UI passed: steady auto-refresh, decoded-frame swap, decode failure, pause discards late frame, no text input, click/drag, navigation, install transition, view-only, disconnect.');
}finally{
  if(driver){await driver.request('quit',{},1000).catch(()=>{});driver.close();}
  for(let i=0;i<50&&child.exitCode===null;i++)await delay(100);
  if(child.exitCode===null)child.kill();child.stdout.destroy();child.stderr.destroy();
  if(path.dirname(fixture)!==path.resolve(os.tmpdir())||!path.basename(fixture).startsWith('pp-phone-basic-ui-'))throw new Error('Invalid fixture cleanup target');
  await rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
const app=await launchProfilePilotE2e({experimentalAgent:false,env:{CPM_START_VIEW:'tools'}});
try{
  await app.driver.waitFor('#tools-phone-app');
  assert.match((await app.driver.query('#tools-phone-app')).text,/可选安装/);
  await app.driver.domClick('.tools-phone-link');await app.driver.waitFor('.phone-empty');
  assert.equal(await app.driver.evaluate('typeof window.phones.basicStart'),'function');
  assert.equal((await app.driver.query('[data-action="phone-apk"]')).disabled,false,'APK available before the first phone is connected');
  assert.equal(await app.driver.evaluate('typeof window.mobile.openApkFolder'),'function');
  console.log('Tools App card navigates to phones with the real preload API.');
}finally{await app.stop();}
