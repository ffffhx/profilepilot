const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runBrowserCli}=require('../dist/main/browser-cli');
const native=require('../dist/main/native-control/cli');
const {planSiteAdapter}=require('../dist/main/site-adapters/catalog');
const {parseXianyuReply}=require('../dist/main/site-adapters/xianyu');
const fixture=require('./fixtures/xianyu/search.json');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-xianyu-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=(name,data)=>{const p=path.join(root,name);if(data!==undefined)fs.writeFileSync(p,'\ufeff'+JSON.stringify(data));return p};return {root,file};}
async function run(args){let stdout='',stderr='';const code=await runBrowserCli(args,{stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}},{});return {code,stdout,stderr,data:stdout.trim().startsWith('{')?JSON.parse(stdout):null};}
test('portable CLI discovers Xianyu and offline comparison accepts BOM and Unicode file names',async t=>{
 const {file}=setup(t),input=file('候选.json',{items:[{id:'101',title:'DDR5 16GB×2',description:'无拆无修',url:'https://www.goofish.com/item?id=101',price:400}]}),criteria=file('条件.json',{excludeRepaired:true,memory:{totalGB:32,pieces:2}}),html=file('对比.html');
 assert.equal((await run(['sites','xianyu'])).data.result.length,3);
 const r=await run(['xianyu','compare','--input',input,'--params-file',criteria,'--html',html]);assert.equal(r.code,0);assert.equal(r.data.result.comparison[0].assessment.verdict,'matches_seller_description');assert.match(fs.readFileSync(html,'utf8'),/闲鱼商品对比/);
 const bad=await run(['xianyu','compare','--input',input,'--params-file',criteria,'--html',input]);assert.notEqual(bad.code,0);assert.match(fs.readFileSync(input,'utf8'),/"items"/);
 const imported=file('export.json',{observations:[{item_id:'101',series:'DDR5',collected_at:'2026-10-25T01:00:00Z',price:400,currency:'CNY',market:'CN',price_type:'listing'}]}),store=file('history.json');
 assert.notEqual((await run(['xianyu','import','--store',store,'--input',imported,'--html',html])).code,0);assert.equal(fs.existsSync(store),false,'validate unsupported flags before changing history');
});
test('scan CLI checks ownership before each read, persists separate history, and never claims or resumes',async t=>{
 const {file}=setup(t),params=file('scan.json',{search:{query:'DDR5 32GB'},detailLimit:0}),store=file('history.json');
 const original=native.requestNativeControl,methods=[];t.after(()=>{native.requestNativeControl=original});
 native.requestNativeControl=async command=>{methods.push(command.method);assert.equal(command.sessionId,'test-session');
  if(command.method==='status')return {sessions:[{sessionId:'test-session',profileId:'native:test',ownership:'agent'}]};
  assert.equal(command.method,'site');return parseXianyuReply(planSiteAdapter(command.params),{state:'ready',data:fixture,url:'https://www.goofish.com/search?q=DDR5',method:'browser-fetch',checkedAt:new Date().toISOString()});
 };
 const result=await run(['--session','test-session','xianyu','scan','--params-file',params,'--store',store]);assert.equal(result.code,0);assert.equal(result.data.result.coverage.candidates,3);assert.equal(result.data.result.history.baseline,true);assert.deepEqual(methods,['status','status','site']);
 const history=await run(['xianyu','history','--store',store,'--item','101']);assert.equal(history.data.result.watches[0].observations.length,1);
});
test('paused session prevents scan and cannot replace the existing baseline with empty results',async t=>{
 const {file}=setup(t),params=file('scan.json',{search:{query:'DDR5'}}),store=file('history.json');
 const original=native.requestNativeControl;let calls=0;t.after(()=>{native.requestNativeControl=original});
 native.requestNativeControl=async command=>{calls++;assert.equal(command.method,'status');return {sessions:[{sessionId:'paused',profileId:'native:test',ownership:'user',pauseReason:'takeover'}]}};
 const r=await run(['--session','paused','xianyu','scan','--params-file',params,'--store',store]);assert.notEqual(r.code,0);assert.equal(calls,1);assert.equal(fs.existsSync(store),false);
});
test('offline re-comparison preserves the original scan budget and updates item assessments as well as table rows',async t=>{
 const {file}=setup(t),input=file('scan-report.json',{options:{search:{query:'DDR5',maxPrice:500}},items:[{id:'101',title:'DDR5 16GBx2',price:600,priceText:'600',assessment:{verdict:'matches_seller_description'}}]}),criteria=file('criteria.json',{memory:{totalGB:32,pieces:2}});
 const r=await run(['xianyu','compare','--input',input,'--params-file',criteria]);assert.equal(r.code,0);assert.equal(r.data.result.comparison[0].assessment.verdict,'mismatch');assert.equal(r.data.result.items[0].assessment.verdict,'mismatch');assert.equal(r.data.result.options.search.maxPrice,500);
});
