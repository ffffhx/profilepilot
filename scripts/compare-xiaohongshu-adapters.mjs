// Compare reviewed bb-sites search code and ProfilePilot over the SAME owned
// extension transport. This is adapter logic timing, not a bb-browser CLI benchmark.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { requestNativeControl } = require('../dist/main/native-control/cli');
const { runSiteAdapter, siteEvaluationValue } = require('../dist/main/site-adapters/runner');
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const sessionId = arg('--session');
if (!sessionId) throw Error('Pass an existing owned --session; this script never claims or resumes.');
const root = path.resolve(arg('--output', 'artifacts/xhs-adapter-comparison/before'));
await mkdir(root, { recursive: true });
const upstreamPath = arg('--upstream-file');
const upstream = upstreamPath ? await readFile(upstreamPath, 'utf8') : undefined;
const variant = arg('--variant', 'existing');
const request = (method, params = {}) => requestNativeControl({ requestId: randomUUID(), sessionId, method, params });
const assertControl = async () => {
  const state = await request('status'), session = state.sessions.find(s => s.sessionId === sessionId);
  if (session?.ownership !== 'agent' || session.pauseReason) throw Error('Browser control changed; stop and reconcile.');
};
const evaluate = async expression => siteEvaluationValue(await request('cdp', { method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
const localRead = input => variant === 'development' ? runSiteAdapter(input, { evaluate, open: url => request('open', { url }) }) : request('site', input);
const inspection = String.raw`(()=>{
  const g=document.querySelector('#app')?.__vue_app__?.config.globalProperties,s=g?.$pinia?._s?.get('search');
  const plain=v=>{try{return JSON.parse(JSON.stringify(v))}catch{return null}};
  return {url:location.href,context:plain(s?.searchContext),filters:plain(s?.filterParams),feedCount:s?.feeds?.length,
    cards:[...document.querySelectorAll('section.note-item')].map(c=>{const a=c.querySelector('a[href*="/explore/"],a[href*="/search_result/"]');return {id:a?.href.match(/(?:explore|search_result)\/([a-f0-9]{24})/)?.[1],title:c.querySelector('.title')?.textContent?.trim()||null}}).filter(c=>c.id)};
})()`;
const queries = ['浏览器自动化', 'Playwright'];
const rounds = Number(arg('--rounds', '2'));
const reports=[];
for (const scenario of ['loaded', 'changed']) for(let round=1;round<=rounds;round++) {
  const modes=upstream ? (round%2 ? [variant,'upstream'] : ['upstream',variant]) : [variant];
  for(const mode of modes) {
    await assertControl();
    const query=queries[(round-1)%queries.length], startQuery=scenario==='loaded'?query:queries[round%queries.length];
    // Reset the page equally. Upstream resets feeds and can leave the visible
    // list empty; one trial's in-page changes must not contaminate the next.
    await request('open',{url:'https://www.xiaohongshu.com/search_result?'+new URLSearchParams({keyword:startQuery,source:'web_search_result_notes'})});
    await new Promise(r=>setTimeout(r,500));
    const preparationDeadline=Date.now()+30000;
    while(Date.now()<preparationDeadline) {
      const ready=await evaluate(`(()=>{const s=document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s?.get('search');return s?.state==='success'&&s.searchContext?.keyword===${JSON.stringify(startQuery)}&&s.feeds?.length>0})()`);
      if(ready) break;
      await new Promise(r=>setTimeout(r,300));
    }
    const prepared=await request('site',{operation:'xiaohongshu.search',params:{query:startQuery,limit:20}});
    if(!['ok','partial'].includes(prepared.status)) throw Error('Preparation failed: '+JSON.stringify(prepared.error));
    await new Promise(r=>setTimeout(r,700));
    const before=await evaluate(inspection), begin=Date.now();
    const result=mode==='upstream'
      ? await evaluate(`(${upstream})(${JSON.stringify({keyword:query,sort:'general'})})`)
      : await localRead({operation:'xiaohongshu.search',params:{query,limit:20}});
    const elapsedMs=Date.now()-begin;
    await assertControl();
    const after=await evaluate(inspection), rows=result.items||result.notes||[];
    const normalized=rows.slice(0,20).map(n=>({id:n.id||n.note_id,title:n.title||null}));
    const domIds=new Set(after.cards.map(c=>c.id));
    const report={at:new Date().toISOString(),scenario,round,mode,query,elapsedMs,status:result.status|| (result.error?'error':'ok'),
      count:rows.length,first20WithTitle:normalized.filter(n=>n.title).length,first20InDom:normalized.filter(n=>domIds.has(n.id)).length,
      before,after,result,upstreamSha256:mode==='upstream'?createHash('sha256').update(upstream).digest('hex'):undefined};
    reports.push(report);
    await writeFile(path.join(root,`${scenario}-${round}-${mode}.json`),JSON.stringify(report,null,2));
    await writeFile(path.join(root,'summary.json'),JSON.stringify({mode:'same-ProfilePilot-transport-adapter-logic',reports},null,2));
    console.log(JSON.stringify({scenario,round,mode,query,elapsedMs,status:report.status,count:report.count,withTitle:report.first20WithTitle,inDom:report.first20InDom}));
  }
}
