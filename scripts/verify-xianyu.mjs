// Live verification through the existing extension service. Never claims,
// resumes, changes Profile, starts a model, or restarts the service.
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {requestNativeControl}=require('../dist/main/native-control/cli');
const {siteEvaluationValue}=require('../dist/main/site-adapters/runner');
const {compareXianyuItems}=require('../dist/main/site-adapters/xianyu-analysis');
const {xianyuReportHtml}=require('../dist/main/site-adapters/xianyu-workflow');

export function genericItems(observation) {
  const items=new Map();
  for(const c of observation.fast?.candidates||[]) {
    try{const u=new URL(c.href);const id=u.searchParams.get('id');
      if(u.origin==='https://www.goofish.com'&&u.pathname==='/item'&&/^\d+$/.test(id))items.set(id,{id,text:c.label||'',url:`https://www.goofish.com/item?id=${id}`});
    }catch{}
  }
  return [...items.values()];
}
export function crosscheck(generic,adapter) {
  const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'');
  const map=new Map(genericItems(generic).map(i=>[i.id,i]));
  return adapter.items.filter(i=>map.has(i.id)).map(i=>{
    const label=map.get(i.id).text,amounts=[...label.matchAll(/[¥￥]\s*(\d[\d,]*(?:\.\d{1,2})?)/g)].map(m=>Number(m[1].replaceAll(',','')));
    return {id:i.id,titleMatches:normalize(label).includes(normalize(i.title)),priceMatches:amounts.length&&i.price!==null?amounts.includes(i.price):null};
  });
}
async function main() {
  if(process.argv.includes('--help')){console.log('node scripts/verify-xianyu.mjs --session OWNED_TASK [--query "DDR5 32GB"] [--max-price 5000] [--output artifacts/xianyu/live]\nRuns search, filtered sort, page 2, regions, and up to 5 details. Existing owned extension session required.');return;}
  const flags={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!['--session','--query','--max-price','--output'].includes(k)||!v||flags[k])throw Error('Invalid/duplicate argument. Use --help.');flags[k]=v;}
  const sessionId=flags['--session'];if(!sessionId)throw Error('An explicitly owned --session is required. No automatic claim/resume.');
  const query=flags['--query']||'DDR5 32GB',maxPrice=Number(flags['--max-price']||5000);
  if(!Number.isFinite(maxPrice)||maxPrice<1||maxPrice>1e8)throw Error('Invalid --max-price.');
  const out=path.resolve(flags['--output']||`artifacts/xianyu/live-${Date.now()}`);
  const request=(method,params={})=>requestNativeControl({requestId:randomUUID(),sessionId,method,params});
  let profileId;
  const guard=async()=>{const status=await request('status'),s=status.sessions.find(s=>s.sessionId===sessionId);
    if(!s||s.ownership!=='agent'||s.pauseReason)throw Error('Browser control is unavailable. Verification stopped; no automatic resume.');
    if(profileId&&profileId!==s.profileId)throw Error('Profile changed; verification stopped.');profileId=s.profileId;};
  await guard();await mkdir(out,{recursive:true});
  const records=[],checks=[];
  const save=(name,data)=>writeFile(path.join(out,name),typeof data==='string'?data:JSON.stringify(data,null,2),'utf8');
  const measure=async(name,method,params)=>{await guard();const start=Date.now();const result=await request(method,params);
    const record={name,method,params,elapsedMs:Date.now()-start,outputBytes:Buffer.byteLength(JSON.stringify(result)),result};records.push(record);await save(name+'.json',record);
    console.log(JSON.stringify({name,status:result.status,count:result.items?.length,elapsedMs:record.elapsedMs,outputBytes:record.outputBytes}));
    if(['blocked','error'].includes(result.status))throw Object.assign(Error(result.error?.message||result.status),{code:result.error?.code});return result;};
  let failure,warmup;
  try {
    await request('open',{url:`https://www.goofish.com/search?q=${encodeURIComponent(query)}`});
    // Wait for actual item links. A fixed delay can benchmark a loading skeleton.
    // This readiness work is reported separately from both warm-page reads.
    const warming=Date.now();let readiness,attempts=0;
    do {
      await guard();readiness=await request('read',{limit:120,textLimit:16000});attempts++;
      if(genericItems(readiness).length>=5)break;
      await new Promise(resolve=>setTimeout(resolve,750));
    }while(Date.now()-warming<20000);
    warmup={elapsedMs:Date.now()-warming,reads:attempts,itemLinks:genericItems(readiness).length};
    await save('readiness.json',{...warmup,result:readiness});
    if(warmup.itemLinks<5)throw Error('Search page did not expose five item links; no loading skeleton was accepted as the generic baseline.');
    const generic=await measure('generic-read','read',{limit:120,textLimit:16000});
    const first=await measure('search','site',{operation:'xianyu.search',params:{query,limit:30,refresh:true}});
    const overlap=crosscheck(generic,first);
    let evidence=overlap;
    if(overlap.some(i=>!i.titleMatches||i.priceMatches!==true)) {
      // Generic control labels are bounded. Check the corresponding actual DOM
      // cards before treating a truncated label as a data mismatch.
      const expression=`(()=>{if(location.origin!=='https://www.goofish.com'||location.pathname!=='/search')throw Error('Search page changed');return {url:location.href,fast:{candidates:[...document.querySelectorAll('a[href]')].filter(a=>a.href.includes('/item?')).map(a=>({href:a.href,label:a.innerText}))}}})()`;
      const raw=await measure('visible-card-evidence','cdp',{method:'Runtime.evaluate',params:{expression,returnByValue:true}});
      evidence=crosscheck(siteEvaluationValue(raw),first);
    }
    checks.push({name:'page-visible-crosscheck',ok:evidence.length>=5&&evidence.every(i=>i.titleMatches&&i.priceMatches===true),overlap:evidence,genericRead:overlap,supplementalDomRead:evidence!==overlap,scope:'Only shared item IDs; independently refreshed lists can differ. Full DOM cards supplement bounded generic labels when needed.'});
    checks.push({name:'search-identities',ok:first.items.length>=5&&new Set(first.items.map(i=>i.id)).size===first.items.length&&first.items.every(i=>/^\d+$/.test(i.id)&&i.title&&i.url===`https://www.goofish.com/item?id=${i.id}`)});
    const filtered=await measure('filtered','site',{operation:'xianyu.search',params:{query,limit:30,minPrice:1,maxPrice,personalOnly:true,sort:'price_asc',refresh:true}});
    checks.push({name:'price-personal-sort',ok:filtered.items.length>0&&filtered.effective.filters?.price.verified===true&&filtered.effective.filters?.personalOnly.verified===true&&filtered.effective.sortVerified===true&&filtered.items.every(i=>i.price!==null&&i.price>=1&&i.price<=maxPrice),effective:filtered.effective});
    if(first.pagination.next){const second=await measure('page2','site',{operation:'xianyu.search',params:{...first.pagination.next,refresh:true}});
      const ids=new Set(first.items.map(i=>i.id));checks.push({name:'pagination',ok:second.effective.pageVerified===true&&second.effective.page===2&&second.items.some(i=>!ids.has(i.id)),overlap:second.items.filter(i=>ids.has(i.id)).length});
    }else checks.push({name:'pagination',ok:false,reason:'No next page available for this query.'});
    const regions=await measure('regions','site',{operation:'xianyu.regions',params:{}});
    checks.push({name:'regions',ok:regions.items.length>0&&regions.items.every(i=>i.id&&i.name)});
    const details=[];
    for(const candidate of first.items.slice(0,5)) {
      const detail=await measure('detail-'+candidate.id,'site',{operation:'xianyu.detail',params:{id:candidate.id}});details.push(detail.items[0]);
      checks.push({name:'detail-'+candidate.id,ok:detail.status==='ok'&&detail.items[0]?.id===candidate.id&&!!detail.items[0]?.description&&detail.items[0]?.price!==null,method:detail.source.method});
    }
    const report={at:new Date().toISOString(),items:details,comparison:compareXianyuItems(details),options:{search:{query}},coverage:{pagesRead:2,candidates:first.items.length,detailsRead:details.length},limitations:['仅本次真实读取的商品；挂牌价与卖家声明不代表最终成交价或实物核验。']};
    await save('comparison.html',xianyuReportHtml(report));
  }catch(error){failure={code:error.code||'VERIFICATION_INTERRUPTED',message:error.message};}
  const summary={at:new Date().toISOString(),platform:process.platform,node:process.version,profileId,status:!failure&&checks.length&&checks.every(c=>c.ok)?'verified':'incomplete',failure,checks,
    measurement:{kind:'deterministic-warm-page-service-reads',samples:1,warmup,metrics:records.map(({name,elapsedMs,outputBytes,result})=>({name,elapsedMs,outputBytes,browserCalls:result.metrics?.browserCalls,itemCount:result.items?.length,genericItemLinks:result.fast?genericItems(result).length:undefined})),
      limitations:['单次通用 read 与结构化读取的实际耗时和输出字节；未运行模型，不代表 token 节省或任务成功率。','通用读取上限 120 控件 / 16000 字符；适配器上限 30 商品；两者字段不同，不能只用字节数判定优劣。','详情、地区和筛选单独计量，不纳入通用搜索读的速度对比。']}};
  await save('summary.json',summary);console.log(JSON.stringify({status:summary.status,output:out,failure}));if(summary.status!=='verified')process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
