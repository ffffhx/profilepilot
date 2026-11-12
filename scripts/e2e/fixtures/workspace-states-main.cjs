const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=process.env.WORKSPACE_REVIEW_ROOT;
if(!root)throw Error('Run scripts/capture-workspace-states.mjs');
app.setPath('userData',path.join(root,'electron-data'));
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',()=>{});
if(process.platform==='darwin')app.setActivationPolicy('accessory');
const results=[];
app.whenReady().then(async()=>{
  try {
    for(const width of [1400,1024,800]) for(const page of ['browser','settings','local-apps','gpui','desktop','phones']) for(const scenario of ['ready','empty','loading','error','empty-default']) {
      if(page==='settings'&&scenario==='empty')continue;
      if(scenario==='empty-default'&&!['browser','phones'].includes(page))continue;
      const window=new BrowserWindow({width,height:900,useContentSize:true,show:false,webPreferences:{offscreen:true,backgroundThrottling:false,preload:path.join(__dirname,'workspace-states-preload.cjs'),additionalArguments:[`--review-scenario=${scenario}`]}});
      let painted,revision=0;const errors=[];
      window.webContents.on('paint',(_event,_dirty,image)=>{const size=image.getSize();if(size.width===width&&size.height===900){painted=image;revision++;}});
      window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
      const evaluate=source=>window.webContents.executeJavaScript(source);
      await window.loadFile(path.join(root,page+'.html'));
      await evaluate('document.fonts.ready.then(()=>true)');
      await new Promise(resolve=>setTimeout(resolve,500));
      const capture=async suffix=>{
        const before=revision, name=`${page}-${scenario}${suffix?'-'+suffix:''}-${width}`;
        await evaluate(`(()=>{let n=document.querySelector('#review-capture-label');if(!n){n=document.createElement('div');n.id='review-capture-label';n.style.cssText='position:fixed;bottom:3px;right:8px;z-index:2147483647;font:10px sans-serif;color:#576a83;background:#fff;padding:2px 4px;pointer-events:none';document.body.append(n);}n.textContent=${JSON.stringify('审查样本 · '+name)};})()`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        window.webContents.invalidate();await new Promise(resolve=>setTimeout(resolve,250));
        for(let i=0;i<40&&revision===before;i++)await new Promise(resolve=>setTimeout(resolve,50));
        if(!painted||revision===before)throw Error('No paint '+name);
        fs.writeFileSync(path.join(root,name+'.png'),painted.toPNG());
        const metrics=await evaluate(`({viewport:[innerWidth,innerHeight],scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText.slice(0,1000),dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})})`);
        results.push({page,scenario,width,suffix,filename:name+'.png',errors:[...errors],...metrics});
      };
      await capture('');
      if(scenario==='empty-default') {
        const action=page==='browser'?'clear-default-profile':'clear-default-device';
        const selector=`[data-action="${action}"]`;
        if(!await evaluate(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`))throw Error('Empty list hid saved default recovery: '+page);
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await new Promise(resolve=>setTimeout(resolve,100));
        if(await evaluate(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`))throw Error('Clear default did not recover: '+page);
        await capture('cleared');
      }
      if(scenario==='error'&&page==='browser'){
        if(!await evaluate(`!!document.querySelector('.registry-error button')`))throw Error('Missing initial-error retry');
        await evaluate(`document.querySelector('.registry-error button').click()`);await capture('retry-loading');
        await new Promise(resolve=>setTimeout(resolve,1000));
        if(!await evaluate(`!!document.querySelector('.registry-state [data-action="new-profile"]') && !document.querySelector('.registry-error')`))throw Error('Initial-error retry did not recover');
        await capture('recovered');
      }
      if(scenario==='ready'&&page==='local-apps'){
        await evaluate(`document.querySelector('[data-action="add"]')?.click()`);await capture('add-dialog');
      }
      if(scenario==='empty'&&page==='phones'){
        await evaluate(`document.querySelector('[data-action="add-device"]')?.click()`);await capture('add-dialog');
      }
      window.destroy();
    }
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({captures:results.length,overflow:results.filter(r=>r.scrollWidth>r.viewport[0]),errors:results.filter(r=>r.errors.length)}));app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
