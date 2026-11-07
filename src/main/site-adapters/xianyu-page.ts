import type { SitePlan } from "./catalog";

export interface XianyuReply { state: "ready" | "waiting" | "error"; url: string; checkedAt: string; method: "browser-fetch" | "page-state" | "dom";
  data?: any; error?: {code:string;message:string}; cached?: boolean; request?: Record<string, any>;
  regionEvidence?: { allowedNames:string[]; scope:"province"|"city"|"area"; resolved:Record<string,string> }; }

/** Read only the current item's already-loaded state, without a second detail
 * request or exposing buyer/account fields from the site's React state. */
export function readXianyuDetailPage(plan:SitePlan):XianyuReply {
  const url=location.href,checkedAt=new Date().toISOString();
  const base={url,checkedAt,method:"page-state" as const};
  const fail=(code:string,message:string):XianyuReply=>({...base,state:"error",error:{code,message}});
  if(location.origin!=="https://www.goofish.com")return fail(/passport|login/.test(url)?"LOGIN_REQUIRED":"ORIGIN_MISMATCH","详情页已跳转离开闲鱼。");
  if(plan.access?.blockedOrigins?.includes(location.origin)||plan.access?.allowedOrigins?.length&&!plan.access.allowedOrigins.includes(location.origin))return fail("ACCESS_BLOCKED","此来源被当前任务限制。");
  if(location.pathname!=="/item"||new URL(url).searchParams.get("id")!==plan.params.id)return fail("RESULT_MISMATCH","当前详情页不属于请求商品。");
  const visible=(e:Element)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=="none"&&getComputedStyle(e).visibility!=="hidden";};
  if([...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="baxia"],#baxia-dialog-content,#nc_1_wrapper')].some(visible))return fail("VERIFICATION_REQUIRED","闲鱼详情要求验证。");
  if([...document.querySelectorAll('iframe[src*="passport"],iframe[src*="mini_login"]')].some(visible))return fail("LOGIN_REQUIRED","闲鱼详情要求登录。");
  const el=document.getElementById("ice-container") as any;
  const holder=el?.[Object.keys(el).find(k=>k.startsWith("__reactContainer"))||""];
  const todo=[holder?.stateNode?.current],seen=new Set();let detail:any;
  while(todo.length&&seen.size<2500&&!detail) {
    const fiber=todo.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);
    if(fiber.sibling)todo.push(fiber.sibling);if(fiber.child)todo.push(fiber.child);
    let hook=fiber.memoizedState;
    for(let i=0;hook&&i<100;i++,hook=hook.next) {
      const value=hook.memoizedState;
      if(value?.itemDO&&(String(value.itemDO.itemId||value.trackParams?.itemId)===plan.params.id)&&typeof value.itemDO.desc==="string") {detail=value;break;}
    }
  }
  if(detail) {
    const d=detail.itemDO,s=detail.sellerDO||{};
    const itemDO=Object.fromEntries(["title","desc","richTextDesc","soldPrice","originalPrice","defaultPriceDesc","minPrice","maxPrice","cpvLabels","itemStatusStr","imageInfos","shippingFee","freight","postage","location"].filter(k=>d[k]!==undefined).map(k=>[k,d[k]]));
    if(d.promotionPriceDO&&typeof d.promotionPriceDO==="object")itemDO.promotionPriceDO=Object.fromEntries(["promotionPriceMin","promotionPriceTag","promotionDesc"].filter(k=>typeof d.promotionPriceDO[k]==="string"||typeof d.promotionPriceDO[k]==="number").map(k=>[k,d.promotionPriceDO[k]]));
    return {...base,state:"ready",data:{ret:["SUCCESS::page-state"],data:{itemDO:{...itemDO,itemId:plan.params.id},sellerDO:{sellerId:s.sellerId,nick:s.nick,userNick:s.userNick,zhimaLevelInfo:s.zhimaLevelInfo}}}};
  }
  const empty=document.querySelector('[class*="empty-container"],[class*="error-container"]');
  if(empty&&visible(empty)&&/不存在|删除|失效|无法查看/.test(empty.textContent||""))return fail("ITEM_UNAVAILABLE",(empty.textContent||"").trim().slice(0,180));
  const desc=document.querySelector('span[class^="desc--"]');
  if(desc?.textContent?.trim()) {
    const amount=document.querySelector('div[class^="price--"]')?.textContent?.trim();
    return {...base,method:"dom",state:"ready",data:{ret:["SUCCESS::dom"],data:{itemDO:{itemId:plan.params.id,desc:desc.textContent.trim(),soldPrice:amount},sellerDO:{}}}};
  }
  return {...base,state:"waiting"};
}

/** Serialized into the owned page. Every invocation is short: SDK promises stay
 * in the page and the host polls under ownership guards, never a long CDP wait. */
export function readXianyuPage(plan: SitePlan, scope = ""): XianyuReply {
  const now = Date.now(), url = location.href;
  const reply = (state: XianyuReply["state"], extra: Partial<XianyuReply> = {}): XianyuReply => ({state,url,checkedAt:new Date(now).toISOString(),method:"browser-fetch",...extra});
  const fail = (code:string,message:string) => reply("error",{error:{code,message}});
  if (location.origin !== "https://www.goofish.com") return fail(/passport|login/.test(location.hostname+location.pathname)?"LOGIN_REQUIRED":"ORIGIN_MISMATCH","页面已离开闲鱼商品网站。");
  const allowed = (origin:string) => !plan.access?.blockedOrigins?.includes(origin) && (!plan.access?.allowedOrigins?.length || plan.access.allowedOrigins.includes(origin));
  if (!allowed(location.origin) || !allowed("https://h5api.m.goofish.com")) return fail("ACCESS_BLOCKED","当前任务限制此网站或其数据接口。");
  const visible = (e:Element) => {const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=="hidden"&&getComputedStyle(e).display!=="none";};
  if ([...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="baxia"],#baxia-dialog-content,#nc_1_wrapper')].some(visible)) return fail("VERIFICATION_REQUIRED","闲鱼要求验证，请检查当前页面。");
  if ([...document.querySelectorAll('iframe[src*="passport"],iframe[src*="mini_login"]')].some(visible)) return fail("LOGIN_REQUIRED","闲鱼要求登录。");
  const runtime = window as any, sdk = runtime.lib?.mtop;
  if (typeof sdk?.request !== "function" || sdk.config?.mainDomain !== "goofish.com" || sdk.config?.subDomain !== "m") return reply("waiting");
  const p=plan.params, op=plan.operation;
  const request:Record<string,any> = op === "xianyu.search" ? {pageNumber:p.page,keyword:p.query,rowsPerPage:30,searchReqFromPage:"pcSearch",fromFilter:false,sortField:"",sortValue:"",customDistance:"",gps:"",customGps:"",propValueStr:{}} : op === "xianyu.regions" ? (p.parentId?{divisionId:p.parentId}:{}) : {itemId:p.id};
  if (op === "xianyu.search") {
    const sorts:Record<string,string[]>={latest:["create","desc"],price_asc:["price","asc"],price_desc:["price","desc"],price_drop:["reduce","desc"]};
    if (sorts[p.sort]) { [request.sortField,request.sortValue]=sorts[p.sort]; request.fromFilter=true; }
    let filter="";
    if (p.minPrice!==undefined||p.maxPrice!==undefined) filter+=`priceRange:${p.minPrice??""},${p.maxPrice??"undefined"};`;
    const quick=[p.personalOnly&&"filterPersonal",p.freeShipping&&"filterFreePostage",p.newOnly&&"filterNew"].filter(Boolean);
    if(quick.length) filter+=`quickFilter:${quick.join(",")};`;
    if(filter) {request.propValueStr={searchFilter:filter};request.fromFilter=true;}
    if(p.region) {request.extraFilterValue=JSON.stringify({divisionList:[p.region],excludeMultiPlacesSellers:"0",extraDivision:""});request.fromFilter=true;}
  }
  const api=op==="xianyu.search"?"mtop.taobao.idlemtopsearch.pc.search":op==="xianyu.regions"?"mtop.taobao.idle.division.all.get":"mtop.taobao.idle.pc.detail";
  const key=JSON.stringify([scope,api,request]);
  const cache = runtime.__profilePilotXianyuReads ||= new Map();
  let entry=cache.get(key);
  // A timed-out SDK request may still be running. Do not duplicate it.
  if(entry?.error) {
    if(now-entry.started<60000)return reply("error",{error:entry.error,request});
    cache.delete(key);entry=undefined;
  }
  if(entry?.done && (!scope || p.refresh || now-entry.done>15000) && !entry.delivered) { /* Return the just-completed request once. */ }
  else if(entry?.done && (!scope || p.refresh || now-entry.done>15000)) {cache.delete(key);entry=undefined;}
  if(!entry) {
    if(cache.size>=12)for(const [oldKey,old] of cache) {
      if((old.done&&!old.error)||now-old.started>=60000)cache.delete(oldKey);
      if(cache.size<12)break;
    }
    if(cache.size>=12)return fail("RATE_LIMITED","页面已有过多尚未结束的读取，请稍后再试。");
    entry={started:now,done:0,delivered:false};cache.set(key,entry);
    const current=entry;
    try {
      Promise.resolve(sdk.request({api,v:op==="xianyu.regions"?"3.0":"1.0",type:"POST",appKey:"34839810",accountSite:"xianyu",dataType:"json",timeout:8000,
        needLogin:false,needLoginPC:false,showErrorToast:false,sessionOption:"AutoLoginOnly",ecode:0,data:request}))
        .then((data:any)=>{current.data=data;current.done=Date.now();},(error:any)=>{current.data={ret:Array.isArray(error?.ret)?error.ret:["REQUEST_FAILED"]};current.done=Date.now();});
    } catch {current.error={code:"REQUEST_FAILED",message:"闲鱼页面 SDK 未能发起读取。"};}
    return reply("waiting",{request});
  }
  if(entry.error) return reply("error",{error:entry.error,request});
  if(!entry.done) {
    if(now-entry.started>10000) {entry.error={code:"REQUEST_TIMEOUT",message:"闲鱼数据读取超过 10 秒；未自动重放，请检查页面后再读。"};return reply("error",{error:entry.error,request});}
    return reply("waiting",{request});
  }
  const cached=entry.delivered;entry.delivered=true;
  return reply("ready",{data:entry.data,checkedAt:new Date(entry.done).toISOString(),cached,request});
}
