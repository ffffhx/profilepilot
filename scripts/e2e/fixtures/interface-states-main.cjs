const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const root=process.env.INTERFACE_REVIEW_ROOT;
if(!root) throw Error('Run scripts/capture-interface-states.mjs');
const output=path.join(root,process.env.INTERFACE_REVIEW_PHASE||'after');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',path.join(root,'electron-data'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',()=>{});
if(process.platform==='darwin')app.setActivationPolicy('accessory');
const results=[];
app.whenReady().then(async()=>{
  try {
    for(const width of [1400,1024,800]){
      const window=new BrowserWindow({width,height:900,useContentSize:true,show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
      let painted, paintRevision=0;
      window.webContents.on('paint',(_event,_dirty,image)=>{const size=image.getSize();if(size.width===width&&size.height===900){painted=image;paintRevision++;}});
      const evaluate=source=>window.webContents.executeJavaScript(source);
      await window.loadFile(path.join(root,'index.html'));
      const cases=await evaluate('interfaceReview.scenarios');
      for(const scenario of cases){
        const previousPaint=paintRevision;
        await evaluate(`interfaceReview.show(${JSON.stringify(scenario)},'win32')`);
        await evaluate(`(() => {let label=document.querySelector('#review-capture-label');if(!label){label=document.createElement('div');label.id='review-capture-label';label.style.cssText='position:fixed;bottom:3px;right:8px;z-index:2147483647;font:10px sans-serif;color:#576a83;background:#fff;padding:2px 4px;pointer-events:none';document.body.append(label);}label.textContent=${JSON.stringify('审查样本 · '+scenario+' · '+width)};})()`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        window.webContents.invalidate();
        await new Promise(resolve=>setTimeout(resolve,150));
        for(let attempt=0;attempt<40 && paintRevision===previousPaint;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
        const shot=painted;
        if(!shot||paintRevision===previousPaint)throw Error('Renderer did not paint: '+scenario);
        if(shot.isEmpty()) throw Error('Empty capture: '+scenario);
        const filename=`${scenario}-${width}.png`;
        fs.writeFileSync(path.join(output,filename),shot.toPNG());
        const metrics=await evaluate(`({viewport:[innerWidth,innerHeight],scrollWidth:document.documentElement.scrollWidth,title:document.querySelector('h1')?.textContent,headings:[...document.querySelectorAll('h1,h2,h3')].filter(n=>n.checkVisibility()).map(n=>({text:n.textContent,size:getComputedStyle(n).fontSize,weight:getComputedStyle(n).fontWeight})),buttons:[...document.querySelectorAll('button')].filter(n=>n.checkVisibility()).map(n=>({text:n.innerText,disabled:n.disabled,height:n.getBoundingClientRect().height,font:getComputedStyle(n).fontSize}))})`);
        results.push({scenario,width,filename,...metrics});
      }
      window.destroy();
    }
    fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({captures:results.length,output,overflow:results.filter(r=>r.scrollWidth>r.viewport[0]+1).map(r=>({scenario:r.scenario,width:r.width,scrollWidth:r.scrollWidth}))}));
    app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
