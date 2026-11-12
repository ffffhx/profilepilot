const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {install}=require('../scripts/development-runtime.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+20000;while(!check()){if(Date.now()>end)throw new Error('Development build timed out');await wait(50);}}
test('source edits really build then reload or restart; generated CSS never loops',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pp-development-'));
  const app=new EventEmitter();let reloads=0,restarts=0;const errors=[];
  app.relaunch=options=>{assert.equal(options.args.at(-1),'--background');restarts++;};app.quit=()=>app.emit('before-quit');
  let watcher;
  try{
    await fs.mkdir(path.join(root,'src/renderer'),{recursive:true});await fs.mkdir(path.join(root,'public'));
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{'bundle:renderer':'node -e "process.exit(0)"','build:css':'node -e "process.exit(0)"',build:'node -e "process.exit(0)"'}}));
    watcher=install({app,root,onError:error=>errors.push(error),webContents:{getAllWebContents:()=>[{isDestroyed:()=>false,getURL:()=> 'file:///app.html',reloadIgnoringCache:()=>reloads++}]}});
    const {developmentProcess}=await import('../scripts/start-independent.mjs');
    assert.equal(developmentProcess(root,process.pid),true);
    assert.equal(developmentProcess(root,process.pid+1),false);
    await wait(200);
    await fs.writeFile(path.join(root,'src/renderer/example.ts'),'first');
    await until(()=>reloads===1||errors.length);assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(root,'public/app.css'),'generated');await wait(1100);assert.equal(reloads,1);
    await fs.writeFile(path.join(root,'src/backend.ts'),'updated CLI');
    await until(()=>restarts===1||errors.length);assert.deepEqual(errors,[]);assert.equal(restarts,1);
    assert.equal(developmentProcess(root,process.pid),false);
  }catch(error){console.error(await fs.readFile(path.join(root,'.tools/development-build.log'),'utf8').catch(()=>''));throw error;}
  finally{watcher?.close();await wait(100);await fs.rm(root,{recursive:true,force:true});}
});
