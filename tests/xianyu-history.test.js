const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readXianyuHistory,recordXianyuScan,importGoofishHistory}=require('../dist/main/site-adapters/xianyu-history');
const dir=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'pp-xianyu-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return path.join(d,'历史.json')};
const result=(price=400,at='2026-10-25T01:00:00Z',id='101',title='DDR5 16GBx2')=>({operation:'xianyu.search',status:'ok',source:{checkedAt:at},items:[{id,title,url:`https://www.goofish.com/item?id=${id}`,price,source:{checkedAt:at}}]});
test('first scan is a baseline; same observation/repeated prices do not repeat alerts; missing items are retained',t=>{
 const f=dir(t),query={query:'DDR5 32GB',maxPrice:500};assert.equal(recordXianyuScan(f,'native:test',query,[result()]).baseline,true);
 assert.equal(recordXianyuScan(f,'native:test',query,[result()]).inserted,0);
 const drop=recordXianyuScan(f,'native:test',query,[result(300,'2026-10-25T02:00:00Z')]);assert.equal(drop.changes[0].kind,'price_drop');
 assert.equal(recordXianyuScan(f,'native:test',query,[result(300,'2026-10-25T03:00:00Z')]).changes.length,0);
 const next=recordXianyuScan(f,'native:test',query,[result(200,'2026-10-25T04:00:00Z','102')]);assert.equal(next.changes[0].kind,'first_seen');
 const watch=Object.values(readXianyuHistory(f).watches)[0];assert.equal(Object.keys(watch.latest).length,2);assert.equal(watch.latest['101'].price,300);
});
test('new listing signals require a publish timestamp within the observed scan interval; old pages cannot move the baseline backwards',t=>{
 const f=dir(t),scope='native:a',query={query:'DDR5'};recordXianyuScan(f,scope,query,[result()]);
 const sample=(id,at,publishedAt)=>{const r=result(400,at,id);r.items[0].publishedAt=publishedAt;return r};
 assert.equal(recordXianyuScan(f,scope,query,[sample('102','2026-10-25T02:00:00Z','2026-10-24T00:00:00Z')]).changes[0].kind,'first_seen');
 const recent=recordXianyuScan(f,scope,query,[sample('103','2026-10-25T03:00:00Z','2026-10-25T02:30:00Z')]);assert.equal(recent.changes[0].kind,'new_listing');assert.equal(recent.changes[0].publishedAt,'2026-10-25T02:30:00.000Z');
 assert.equal(recordXianyuScan(f,scope,query,[sample('104','2026-10-25T04:00:00Z','2026-10-25T05:00:00Z')]).changes[0].kind,'first_seen');
 assert.equal(recordXianyuScan(f,scope,query,[sample('105','2026-10-25T00:00:00Z','2026-10-24T23:00:00Z')]).inserted,0);
 assert.equal(Object.values(readXianyuHistory(f).watches)[0].lastScanAt,'2026-10-25T04:00:00.000Z');
});
test('the first multi-page scan retains earlier pages while using the last sample as the next scan boundary',t=>{
 const f=dir(t),saved=recordXianyuScan(f,'native:a',{},[result(400,'2026-10-25T01:00:00Z','101'),result(300,'2026-10-25T01:00:10Z','102')]);
 assert.equal(saved.inserted,2);assert.deepEqual(saved.changes,[]);
 const watch=Object.values(readXianyuHistory(f).watches)[0];assert.equal(watch.lastScanAt,'2026-10-25T01:00:10.000Z');assert.equal(Object.keys(watch.latest).length,2);
});
test('profile/filter changes establish separate baselines; changed specifications are not price-drop signals',t=>{
 const f=dir(t);recordXianyuScan(f,'native:a',{query:'DDR5'},[result()]);
 assert.equal(recordXianyuScan(f,'native:b',{query:'DDR5'},[result()]).baseline,true);
 assert.equal(recordXianyuScan(f,'native:a',{query:'DDR5',maxPrice:500},[result()]).baseline,true);
 assert.equal(recordXianyuScan(f,'native:a',{query:'DDR5'},[result(100,'2026-10-25T02:00:00Z','101','DDR5 8GBx2')]).changes[0].kind,'listing_changed');
});
test('failed reads do not poison history and concurrent writers are rejected without replacing existing data',t=>{
 const f=dir(t);assert.throws(()=>recordXianyuScan(f,'native:a',{},[{...result(),status:'blocked'}]),/没有成功/);assert.equal(fs.existsSync(f),false);
 recordXianyuScan(f,'native:a',{},[result()]);const before=fs.readFileSync(f,'utf8');fs.writeFileSync(f+'.lock','occupied');assert.throws(()=>recordXianyuScan(f,'native:a',{},[result(1)]),/另一进程/);assert.equal(fs.readFileSync(f,'utf8'),before);
});
test('existing goofish history exports preserve dates and item identity, deduplicate imports and reject mixed prices',t=>{
 const f=dir(t),input={observations:[{item_id:'101',product_id:'shared-product',series:'DDR5',date:'2026-09-01',collected_at:'2026-09-01T04:00:00Z',price:400,currency:'CNY',market:'CN',price_type:'listing'}]};
 assert.equal(importGoofishHistory(f,input).inserted,1);assert.equal(importGoofishHistory(f,input).inserted,0);
 const row=readXianyuHistory(f).watches['import:ai-goofish-monitor'].observations[0];assert.equal(row.id,'101');assert.equal(row.at,'2026-09-01T04:00:00.000Z');
 input.observations[0].price_type='sold';assert.throws(()=>importGoofishHistory(f,input),/挂牌价/);
});
test('timezone-less source history is preserved consistently across host timezones; mixed time bases are not ranked',t=>{
 const {spawnSync}=require('node:child_process');
 const rows=['2026-09-01 12:34:56.123456','2026-09-02','2026-09-01T04:34:56Z'].map(collected_at=>({item_id:'101',series:'DDR5',collected_at,price:400,currency:'CNY',market:'CN',price_type:'listing'}));
 const source=require.resolve('../dist/main/site-adapters/xianyu-history');
 const run=tz=>{const file=dir(t);const code=`const m=require(process.argv[1]);m.importGoofishHistory(process.argv[2],JSON.parse(process.argv[3]));process.stdout.write(JSON.stringify(m.readXianyuHistory(process.argv[2]).watches['import:ai-goofish-monitor']));`;
  const p=spawnSync(process.execPath,['-e',code,source,file,JSON.stringify({observations:rows})],{encoding:'utf8',env:{...process.env,TZ:tz},windowsHide:true});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout)};
 const a=run('Asia/Shanghai'),b=run('America/Los_Angeles');assert.deepEqual(a.observations,b.observations);assert.deepEqual(a.latest,{});
 assert.equal(a.observations[0].at,'2026-09-01T12:34:56.123456');assert.equal(a.observations[0].originalAt,rows[0].collected_at);assert.equal(a.observations[0].timeBasis,'source-local');assert.equal(a.observations[1].at,'2026-09-02');assert.equal(a.observations[1].timeBasis,'date-only');
 assert.throws(()=>recordXianyuScan(dir(t),'native:a',{},[result(400,'2026-09-01 12:34:56')]),/时区/);
 assert.throws(()=>importGoofishHistory(dir(t),{observations:[{...rows[0],collected_at:'2026-02-30'}]}),/时间无效/);
});
