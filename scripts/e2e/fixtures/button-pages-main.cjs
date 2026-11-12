const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.BUTTON_LAYOUT_FIXTURE;
if (!root) throw Error('Run scripts/verify-button-layout.mjs');
app.setPath('userData',path.join(root,'page-user-data'));
app.on('window-all-closed',()=>{});
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
const results=[];
const error='测试连接暂时不可用，请稍后重新检查连接。';
const measure = scope => `(() => {const scope=document.querySelector(${JSON.stringify(scope)})||document;const counts={}; const boxes={};for(const node of scope.querySelectorAll('button,input,select,textarea,dialog[open]')){const r=node.getBoundingClientRect();if(!r.width||!r.height||getComputedStyle(node).visibility==='hidden')continue;const base=node.id||node.tagName+JSON.stringify(node.dataset)+(node.name||'')+(node.type||''); const i=counts[base]||0; counts[base]=i+1;boxes[base+':'+i]=[r.x,r.y,r.width,r.height];}return boxes;})()`;
const diff=(a,b)=>Object.entries(a).flatMap(([key,box])=>!b[key]?[{key,missing:true}]:box.some((n,i)=>Math.abs(n-b[key][i])>.2)?[{key,before:box,after:b[key]}]:[]);
app.whenReady().then(async()=>{
  try {
    for(const width of [1200,760]) for(const platform of ['win32','darwin']) {
      const window=new BrowserWindow({show:false,width,height:900,useContentSize:true,webPreferences:{preload:path.join(__dirname,'button-pages-preload.cjs'),backgroundThrottling:false,additionalArguments:[`--layout-platform=${platform}`]}});
      const evaluate=source=>window.webContents.executeJavaScript(source);
      const wait=async source=>{for(let i=0;i<150;i++){if(await evaluate(source))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+source);};
      const load=async page=>{await window.loadFile(path.join(root,page+'.html'));await wait('!!window.layoutFixture');};
      const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      async function check(name,method,action,scope='body',reject=false,compareAfter=true){
        await evaluate(`layoutFixture.hold(${JSON.stringify(method)})`);
        const before=await evaluate(measure(scope));
        await action(); await wait(`layoutFixture.pending()===${JSON.stringify(method)}`);
        const during=await evaluate(measure(scope));
        await evaluate(`layoutFixture.settle(${JSON.stringify(reject?error:null)})`);
        await new Promise(r=>setTimeout(r,60));
        const after=await evaluate(measure(scope));
        if(await evaluate(`!!document.querySelector(${JSON.stringify(scope)}).querySelector('button[aria-busy="true"]')`)) throw Error(`${name}: button still reports busy after completion`);
        results.push({width,platform,name,changes:diff(before,during),restored:compareAfter?diff(before,after):[]});
      }
      await load('settings'); await wait('!document.querySelector("[data-action=refresh-startup]").disabled');
      await check('startup-refresh','settings-read',()=>click('[data-action=refresh-startup]'));
      await check('startup-toggle','settings-save',()=>click('[data-action=toggle-startup]'));
      await load('gpui'); await wait('document.querySelector("#gpui-backend").textContent.includes("fixture")');
      await check('gpui-refresh','gpui-status',()=>click('#gpui-refresh'));
      await load('desktop'); await wait('!!document.querySelector("#desktop-refresh") && !document.querySelector("#desktop-refresh").disabled');
      await check('desktop-refresh','desktop-status',()=>click('#desktop-refresh'));
      if(platform==='win32'){
        await click('.desktop-window'); await new Promise(r=>setTimeout(r,40));
        await check('desktop-preview','desktop-preview',()=>click('.desktop-window'));
      }
      await load('local-apps'); await wait('!!document.querySelector("[data-action=start]")');
      await check('app-start','apps-start',()=>click('[data-action=start]'));
      await check('app-refresh','apps-list',()=>click('[data-action=refresh]'));
      await click('[data-action=add]'); await wait('!!document.querySelector("#local-app-dialog[open]")');
      await evaluate(`document.querySelector('[name=name]').value='Fixture';document.querySelector('[name=cwd]').value='/fixture';`);
      await check('app-save','apps-save',()=>evaluate(`document.querySelector('.app-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`),'#local-app-dialog',true);
      await click('[data-cancel]');
      await evaluate('layoutFixture.attachApp()');await click('[data-action=refresh]');await wait('!!document.querySelector("[data-action=connect]")');
      await click('[data-action=connect]');await wait('!!document.querySelector("[data-check]") && !document.querySelector("[data-check]").disabled');
      await check('app-connect','apps-connect',()=>click('[data-check]'),'.app-connection-dialog',true);
      await load('phones'); await wait('!!window.phoneButtonLayout');
      await evaluate('phoneButtonLayout.wireless()');await wait('!document.querySelector("[data-scan]").disabled');
      await check('wireless-scan','wireless-scan',()=>click('[data-scan]'),'.phone-wireless-dialog');
      await click('[data-next]'); await wait('!!document.querySelector("[data-pair-form]")');
      await evaluate(`document.querySelector('[name=pairAddress]').value='192.0.2.1:12345';document.querySelector('[name=pairCode]').value='123456';`);
      await check('wireless-pair','wireless-pair',()=>evaluate(`document.querySelector('[data-pair-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`),'.phone-wireless-dialog',true);
      await load('phones');await evaluate('phoneButtonLayout.wireless()');await wait('!!document.querySelector("[data-direct]")');await click('[data-direct]');
      await evaluate(`document.querySelector('[name=connectAddress]').value='192.0.2.1:12345';`);
      await check('wireless-connect','wireless-connect',()=>evaluate(`document.querySelector('[data-connect-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`),'.phone-wireless-dialog',true);
      await load('phones');await evaluate('phoneButtonLayout.emulator("connect")');await wait('!!document.querySelector("[data-emulator-name]")');
      await check('emulator-refresh','emulator-list',()=>click('[data-emulator-refresh]'),'.phone-emulator-dialog');
      await check('emulator-connect','emulator-connect',()=>click('[data-emulator-name]'),'.phone-emulator-dialog',true);
      await load('phones');await evaluate('layoutFixture.hold("wireless-auto");phoneButtonLayout.wireless("fixture")');await wait('layoutFixture.pending()==="wireless-auto"');await evaluate(`layoutFixture.settle(${JSON.stringify(error)})`);await wait('!document.querySelector("[data-auto]").disabled');
      await check('wireless-auto','wireless-auto',()=>click('[data-auto]'),'.phone-wireless-dialog',true);
      await load('phones');await evaluate('phoneButtonLayout.emulator("create")');await wait('!!document.querySelector("[data-create-device]") && !document.querySelector("[data-create-device]").disabled');
      await check('emulator-catalog','emulator-catalog',()=>click('[data-setup-refresh]'),'.phone-emulator-dialog',true);
      await check('emulator-create','emulator-create',()=>evaluate(`document.querySelector('[data-create-form]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`),'.phone-emulator-dialog',true);
      await load('phones');await evaluate('phoneButtonLayout.iphone()');await wait('document.querySelector("[data-tools-status]").textContent.includes("fixture")');
      await check('iphone-refresh','iphone-tools',()=>click('[data-do=refresh]'),'.iphone-setup-dialog',true);
      await check('iphone-setup','iphone-setup',()=>click('[data-do=setup]'),'.iphone-setup-dialog',true);
      window.destroy();
    }
    fs.writeFileSync(path.join(root,'page-results.json'),JSON.stringify(results,null,2));
    const failed=results.filter(r=>r.changes.length||r.restored.length);
    console.log(JSON.stringify({pageCases:results.length,failed:failed.map(r=>({...r,changes:r.changes.slice(0,3),restored:r.restored.slice(0,3)}))}));
    app.exit(failed.length?1:0);
  }catch(error){console.error(error);fs.writeFileSync(path.join(root,'page-results.json'),JSON.stringify(results,null,2));app.exit(1);}
});
