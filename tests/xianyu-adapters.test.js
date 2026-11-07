const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {planSiteAdapter}=require('../dist/main/site-adapters/catalog');
const {parseXianyuReply,runXianyuAdapter}=require('../dist/main/site-adapters/xianyu');
const {readXianyuPage,readXianyuDetailPage}=require('../dist/main/site-adapters/xianyu-page');
const {assessXianyuItem}=require('../dist/main/site-adapters/xianyu-analysis');
const {scanXianyu,xianyuReportHtml}=require('../dist/main/site-adapters/xianyu-workflow');
const fixture=require('./fixtures/xianyu/search.json');
const clone=()=>structuredClone(fixture);
const plan=(params={})=>planSiteAdapter({operation:'xianyu.search',params:{query:'DDR5 32GB',...params}});
const parse=(data=clone(),params={})=>parseXianyuReply(plan(params),{state:'ready',data,url:'https://www.goofish.com/search?q=DDR5%2032GB',method:'browser-fetch',checkedAt:'2026-10-25T00:00:00.000Z'});

test('Xianyu live response shape normalizes exact IDs/prices, location, links and original seller statements',()=>{
 const r=parse();assert.equal(r.items.length,3);assert.equal(r.items[0].id,'101');assert.equal(r.items[0].price,2380);assert.equal(r.items[0].region,'安徽');assert.equal(r.items[0].seller.name,null);assert.equal(r.items[0].shipping.free,true);assert.equal(r.items[0].priceType,'listing');assert.match(r.items[0].title,/无维修/);assert.equal(r.effective.pageVerified,true);
 assert.equal(r.pagination.next.page,2);
});
test('pagination remains on the same response before moving to the next page; ads and duplicates are excluded',()=>{
 const d=clone();d.data.resultList.push(d.data.resultList[0]);const ad=structuredClone(d.data.resultList[0]);ad.data.item.main.exContent.isAliMaMaAD=true;d.data.resultList.push(ad);
 const r=parse(d,{limit:1});assert.equal(r.items.length,1);assert.equal(r.pagination.next.itemOffset,1);assert.equal(r.pagination.next.page,1);assert.equal(r.effective.excludedAds,1);assert.equal(parse(d,{itemOffset:2,limit:1}).pagination.next.page,2);
});
test('stale queries, wrong pages, unsafe numeric IDs and damaged structures are not empty successful searches',()=>{
 const d=clone();d.data.resultInfo.trackParams.page='2';assert.equal(parse(d).error.code,'RESULT_MISMATCH');
 d.data.resultInfo.trackParams.page='1';d.data.resultInfo.sqiControlFields.userInputOriginalSearchKeywords='old';assert.equal(parse(d).error.code,'RESULT_MISMATCH');
 assert.equal(parse({ret:['SUCCESS::调用成功'],data:{}}).error.code,'SCHEMA_CHANGED');
 const bad=clone();for(const r of bad.data.resultList)r.data.item.main.exContent.itemId=9223372036854775807;assert.equal(parse(bad).status,'error');
 const empty=clone();empty.data.resultList=[];empty.data.resultInfo.hasNextPage=false;assert.equal(parse(empty).status,'empty');assert.equal(parse({ret:['FAIL_SYS_USER_VALIDATE'],data:{}}).status,'blocked');
});
test('price/region/sort verification reports actual evidence and never treats requested filters as verified',()=>{
 let r=parse(clone(),{maxPrice:500,personalOnly:true,region:{province:'上海市',city:'上海市'}});assert.equal(r.status,'partial');assert.equal(r.items.length,0);assert.equal(r.effective.filters.price.verified,false);assert.equal(r.effective.filters.personalOnly.verified,false);assert.equal(r.effective.filters.region.verified,false);assert.equal(r.pagination.hasMore,true);
 r=parse(clone(),{sort:'price_asc'});assert.equal(r.effective.sortVerified,true);
 const d=clone();d.data.resultList.reverse();r=parse(d,{sort:'price_asc'});assert.equal(r.effective.sortVerified,false);assert.equal(r.status,'partial');
 assert.throws(()=>plan({minPrice:500,maxPrice:400}),/最低/);assert.throws(()=>plan({region:{province:'上海',area:'浦东'}}),/城市/);
});
test('abbreviated prices retain exact business amounts; full-new tags and selected region child labels are recognized',()=>{
 const d=clone();d.data.resultList=d.data.resultList.slice(0,2);
 for(const [n,row] of d.data.resultList.entries()){const m=row.data.item.main;m.exContent.price=[{text:'¥'},{text:n?'99.99万':'500万'}];m.clickParam.args.displayPrice=n?'999999':'5000000';m.clickParam.args.tag='new/freeship';m.exContent.fishTags={};m.exContent.area=n?'裕华区':'新华区';}
 const p=plan({sort:'price_desc',newOnly:true,region:{province:'河北',city:'石家庄'}});
 const r=parseXianyuReply(p,{state:'ready',data:d,url:p.url,method:'browser-fetch',checkedAt:new Date().toISOString(),regionEvidence:{scope:'city',resolved:{province:'河北',city:'石家庄'},allowedNames:['石家庄','新华区','裕华区']}});
 assert.equal(r.status,'ok');assert.deepEqual(r.items.map(i=>i.price),[5000000,999999]);assert.equal(r.items[1].priceText,'¥99.99万');assert.equal(r.effective.sortVerified,true);assert.equal(r.effective.filters.newOnly.verified,true);assert.equal(r.effective.filters.region.verified,true);
 assert.equal(assessXianyuItem(r.items[0],undefined,{newOnly:true,freeShipping:true,region:{province:'河北',city:'石家庄'}}).verdict,'matches_seller_description');
 d.data.resultList[0].data.item.main.exContent.area='外地';assert.equal(parseXianyuReply(p,{state:'ready',data:d,url:p.url,method:'browser-fetch',checkedAt:new Date().toISOString(),regionEvidence:{scope:'city',resolved:{province:'河北',city:'石家庄'},allowedNames:['新华区']}}).effective.filters.region.verified,false);
 d.data.resultList[0].data.item.main.exContent.price=[{text:'¥100起'}];assert.equal(parse(d).items[0].price,null,'starting prices cannot use exact-price fallback');
});
test('detail preserves full description and fails on wrong identity or business rejection',()=>{
 const p=planSiteAdapter({operation:'xianyu.detail',params:{id:'101'}}),reply={state:'ready',url:p.url,checkedAt:new Date().toISOString(),method:'browser-fetch',data:{ret:['SUCCESS::调用成功'],data:{itemDO:{itemId:'101',title:'内存套条',desc:'16GB×2，无拆无修，价格为两条',soldPrice:'400',imageInfos:[{url:'https://img.alicdn.com/a.jpg'}]},sellerDO:{sellerId:'201',nick:'卖家'}}}};
 const r=parseXianyuReply(p,reply);assert.equal(r.items[0].description,'16GB×2，无拆无修，价格为两条');assert.equal(r.items[0].price,400);assert.equal(r.items[0].seller.name,'卖家');
 reply.data.data.itemDO.soldPrice=399.5;assert.equal(parseXianyuReply(p,reply).items[0].price,399.5);
 reply.data.data.itemDO.itemId='102';assert.equal(parseXianyuReply(p,reply).error.code,'RESULT_MISMATCH');
 for(const [ret,code] of [['FAIL_SYS_SESSION_EXPIRED','LOGIN_REQUIRED'],['FAIL_SYS_USER_VALIDATE','VERIFICATION_REQUIRED'],['FAIL_SYS_TRAFFIC_LIMIT','RATE_LIMITED']]){reply.data.ret=[ret];assert.equal(parseXianyuReply(p,reply).error.code,code);}
});
test('detail reads only matching current React data, excludes buyer data and retains explicit sold status',()=>{
 const data={itemDO:{itemId:'101',desc:'完整描述',soldPrice:'300',itemStatusStr:'卖掉了'},sellerDO:{sellerId:'201',nick:'卖家'},buyerDO:{private:'must not escape'}};
 const fiber={memoizedState:{memoizedState:data}},el={'__reactContainer$test':{stateNode:{current:fiber}}};
 const p=planSiteAdapter({operation:'xianyu.detail',params:{id:'101'}});
 const context={location:new URL(p.url),document:{getElementById:()=>el,querySelectorAll:()=>[],querySelector:()=>null},Date,Set,URL};
 const reply=vm.runInNewContext(`(${readXianyuDetailPage.toString()})(${JSON.stringify(p)})`,context);
 assert.equal(reply.state,'ready');assert.equal(reply.data.data.buyerDO,undefined);assert.equal(parseXianyuReply(p,reply).items[0].status.label,'sold');
 data.itemDO.itemId='102';assert.equal(vm.runInNewContext(`(${readXianyuDetailPage.toString()})(${JSON.stringify(p)})`,context).state,'waiting');
});
test('detail matches the visible promotion price without flattening range or conditional labels',()=>{
 const p=planSiteAdapter({operation:'xianyu.detail',params:{id:'101'}});
 const data={itemDO:{itemId:'101',desc:'DDR5 32GB 内存',soldPrice:'2847',promotionPriceDO:{promotionPriceMin:'2717.00',promotionPriceTag:'活动价',promotionDesc:'以页面活动规则为准',privateField:'must not escape'}}};
 const fiber={memoizedState:{memoizedState:data}},el={'__reactContainer$test':{stateNode:{current:fiber}}};
 const context={location:new URL(p.url),document:{getElementById:()=>el,querySelectorAll:()=>[],querySelector:()=>null},Date,Set,URL};
 const read=()=>vm.runInNewContext(`(${readXianyuDetailPage.toString()})(${JSON.stringify(p)})`,context);
 const reply=read(),item=parseXianyuReply(p,reply).items[0];
 assert.equal(item.price,2717);assert.equal(item.priceBasis,'promotion-price');assert.equal(item.priceType,'listing');assert.equal(item.promotion.regularPrice,2847);
 assert.equal(reply.data.data.itemDO.promotionPriceDO.privateField,undefined);
 data.itemDO.defaultPriceDesc='定金100元起';assert.equal(parseXianyuReply(p,read()).items[0].price,null);
 data.itemDO.minPrice='2000';data.itemDO.maxPrice='3000';assert.equal(parseXianyuReply(p,read()).items[0].priceText,'2000 - 3000');
 delete data.itemDO.minPrice;delete data.itemDO.maxPrice;delete data.itemDO.defaultPriceDesc;data.itemDO.soldPrice='0';assert.equal(parseXianyuReply(p,read()).items[0].price,0);
});
test('SDK starts once, polls without blocking CDP, isolates cache scope and refuses to replay uncertain timeout',async()=>{
 let resolve,count=0,now=1000;const sdk={config:{mainDomain:'goofish.com',subDomain:'m'},request:()=>{count++;return new Promise(r=>{resolve=r})}};
 class Clock extends Date {constructor(v){super(v??now)}static now(){return now}}
 const context={window:{lib:{mtop:sdk}},location:new URL('https://www.goofish.com/search?q=DDR5'),document:{querySelectorAll:()=>[]},Date:Clock,Promise,Map,URL,JSON};
 const read=(scope='one',params={})=>vm.runInNewContext(`(${readXianyuPage.toString()})(${JSON.stringify(plan(params))},${JSON.stringify(scope)})`,context);
 assert.equal(read().state,'waiting');assert.equal(read().state,'waiting');assert.equal(count,1);
 resolve(clone());await new Promise(r=>setImmediate(r));assert.equal(read().state,'ready');assert.equal(read().cached,true);assert.equal(count,1);
 assert.equal(read('two').state,'waiting');assert.equal(count,2);now+=11000;assert.equal(read('two').error.code,'REQUEST_TIMEOUT');assert.equal(read('two',{refresh:true}).error.code,'REQUEST_TIMEOUT');assert.equal(count,2);
 now+=60000;assert.equal(read('two',{refresh:true}).state,'waiting');assert.equal(count,3);
 for(let i=0;i<12;i++)read('pending-'+i);
 const size=context.window.__profilePilotXianyuReads.size;assert.equal(size,12);
 const before=count;assert.equal(read('overflow').error.code,'RATE_LIMITED');assert.equal(count,before);
 assert.equal(read('two').state,'waiting');assert.equal(count,before,'an in-flight request must not be evicted and replayed');
});
test('SDK origin restrictions are checked before any request and selectors do not treat hidden login frames as a block',()=>{
 let calls=0;const context={window:{lib:{mtop:{config:{mainDomain:'goofish.com',subDomain:'m'},request:()=>{calls++;return new Promise(()=>{})}}}},location:new URL('https://www.goofish.com/'),document:{querySelectorAll:()=>[]},Date,Promise,Map,URL};
 const p=plan();p.access={blockedOrigins:['https://h5api.m.goofish.com']};const r=vm.runInNewContext(`(${readXianyuPage.toString()})(${JSON.stringify(p)})`,context);assert.equal(r.error.code,'ACCESS_BLOCKED');assert.equal(calls,0);
});
test('control takeover aborts before subsequent SDK poll or navigation',async()=>{
 let checks=0,calls=0;
 await assert.rejects(runXianyuAdapter({operation:'xianyu.search',params:{query:'DDR5'}},{check:()=>{if(++checks===4)throw new Error('takeover')},evaluate:async()=>{calls++;return {url:'https://www.goofish.com/search?q=DDR5'}},open:async()=>assert.fail()}),/takeover/);assert.equal(calls,1);
});
test('region search resolves the actual hierarchy before querying and rejects unknown child regions',async()=>{
 const d=clone();for(const row of d.data.resultList)row.data.item.main.exContent.area='新华区';
 const region=items=>({state:'ready',url:'https://www.goofish.com/search',method:'browser-fetch',checkedAt:new Date().toISOString(),data:{ret:['SUCCESS::ok'],data:{divisionArea:items}}});
 const root=region([{id:'130000',na:'河北',hasChild:true}]),city=region([{id:'130100',na:'石家庄',hasChild:true}]),district=region([{id:'130105',na:'新华区',hasChild:false}]);
 let calls=[];const queued=[{url:'https://www.goofish.com/search'},root,city,district,{...root,data:d}];
 const r=await runXianyuAdapter({operation:'xianyu.search',params:{query:'DDR5 32GB',region:{province:'河北省',city:'石家庄市'}}},{check:()=>{},cacheScope:'region-test',evaluate:async expression=>{calls.push(expression);return queued.shift()},open:async()=>assert.fail()});
 assert.equal(r.effective.filters.region.verified,true);assert.equal(calls.length,5);assert.match(calls[4],/"region":\{"province":"河北","city":"石家庄"\}/);
 const invalid=[{url:'https://www.goofish.com/search'},root,city];calls=[];
 const bad=await runXianyuAdapter({operation:'xianyu.search',params:{query:'DDR5',region:{province:'河北',city:'不存在的市'}}},{evaluate:async expression=>{calls.push(expression);return invalid.shift()},open:async()=>assert.fail()});
 assert.equal(bad.error.code,'REGION_NOT_FOUND');assert.equal(calls.length,3);
});
test('comparison distinguishes kits, single-unit price, repair claims, deposits, missing facts and HTML injection',()=>{
 const criteria={include:[],exclude:[],excludeRepaired:true,memory:{generation:'DDR5',totalGB:32,pieces:2}};
 const kit=assessXianyuItem({title:'DDR5 16GB×2 32GB套条',description:'无拆无修。两条一起出'},criteria);assert.equal(kit.verdict,'matches_seller_description');assert.equal(kit.facts.repaired.value,false);
 assert.equal(assessXianyuItem({title:'DDR5 32GB单条',description:'无维修'},criteria).verdict,'mismatch');
 assert.equal(assessXianyuItem({title:'DDR5 16GBx2',description:'无拆无修。价格为单根价格'},criteria).verdict,'needs_confirmation');
 assert.equal(assessXianyuItem({title:'DDR5 16GBx2',description:'维修过，更换芯片'},criteria).verdict,'mismatch');
 assert.equal(assessXianyuItem({title:'DDR5 16GBx2',description:'无拆无修，实际维修过'},criteria).verdict,'mismatch');
 assert.equal(assessXianyuItem({title:'DDR5 2x16GB',description:'没有修过'},criteria).verdict,'matches_seller_description');
 assert.equal(assessXianyuItem({title:'DDR5 32GB',description:'先付定金'},criteria).verdict,'needs_confirmation');
 assert.equal(assessXianyuItem({title:'DDR5 16GB套条',description:'无维修'},criteria).verdict,'needs_confirmation');
 const perUnit=assessXianyuItem({title:'DDR5 32g 笔记本',description:'价格为单根的价格，有2根打包一起出，不单出'},criteria);
 assert.equal(perUnit.facts.pieces.value,2);assert.equal(perUnit.facts.totalGB,undefined);assert.ok(perUnit.issues.some(i=>i.code==='UNIT_PRICE'));
 assert.ok(assessXianyuItem({title:'32g DDR5 坏的，无法开 机'}).issues.some(i=>i.code==='PARTS_OR_FAULTY'));
 assert.match(xianyuReportHtml({comparison:[{title:'<script>alert(1)</script>',url:'javascript:alert(1)',assessment:{checks:[]}}]}),/&lt;script&gt;/);
 assert.doesNotMatch(xianyuReportHtml({comparison:[{title:'x',url:'javascript:alert(1)',assessment:{checks:[]}}]}),/href="javascript:/);
});
test('scan deduplicates pages, reads only selected details and stops on verification instead of repeating',async()=>{
 const search=parse(),calls=[];search.pagination.next={...plan().params,page:2};const report=await scanXianyu({search:{query:'DDR5 32GB'},maxPages:2,detailLimit:3},async input=>{
  calls.push(input);if(input.operation==='xianyu.search')return search;return {...search,operation:'xianyu.detail',status:'blocked',items:[],error:{code:'VERIFICATION_REQUIRED',message:'verification'}};
 });assert.equal(calls.length,3);assert.equal(report.items.length,3);assert.equal(report.status,'partial');assert.equal(report.details.length,1);
});
test('detail price and availability override list suitability; a removed item does not prevent checking other candidates',async()=>{
 const search=parse();search.items=['101','102','103','104'].map(id=>({id,title:'DDR5 16GBx2',description:'无拆无修',price:300,priceText:'300',url:`https://www.goofish.com/item?id=${id}`,source:search.source}));
 const criteria={excludeRepaired:true,memory:{generation:'DDR5',totalGB:32,pieces:2}},calls=[];
 const report=await scanXianyu({search:{query:'DDR5',maxPrice:500,criteria},detailLimit:4},async input=>{
  calls.push(input);if(input.operation==='xianyu.search')return search;
  const id=input.params.id;
  if(id==='103')return {...search,operation:'xianyu.detail',status:'error',items:[],error:{code:'ITEM_UNAVAILABLE',message:'商品已删除'}};
  const price=id==='101'?600:450;
  return {...search,operation:'xianyu.detail',items:[{...search.items.find(i=>i.id===id),price,priceText:String(price),status:{label:id==='102'?'sold':'available',raw:id==='102'?'卖掉了':'在线'}}]};
 });
 assert.equal(calls.length,5);assert.equal(report.stopped,undefined);assert.equal(report.status,'partial');
 assert.deepEqual(report.comparison.map(i=>i.assessment.verdict),['mismatch','mismatch','mismatch','matches_seller_description']);
 assert.deepEqual(report.items.map(i=>i.assessment),report.comparison.map(i=>i.assessment));
 assert.equal(assessXianyuItem({title:'DDR5 16GBx2',description:'无拆无修',price:null},criteria,{maxPrice:500}).verdict,'needs_confirmation');
});
