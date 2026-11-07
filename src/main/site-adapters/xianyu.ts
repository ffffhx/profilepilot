import { planSiteAdapter, type SiteInput, type SitePlan, type SiteResult } from "./catalog";
import type { SiteTransport } from "./runner";
import { readXianyuPage, readXianyuDetailPage, type XianyuReply } from "./xianyu-page";
import { assessXianyuItem } from "./xianyu-analysis";

const text=(v:any):string=>typeof v==="string"?v.trim():typeof v==="number"&&Number.isFinite(v)?String(v):"";
const identifier=(v:any):string|null=>typeof v==="number"&&!Number.isSafeInteger(v)?null:/^\d{1,30}$/.test(text(v))?text(v):null;
const price=(v:any):number|null=>{const s=text(v).replace(/[¥￥,\s]/g,"");return /^\d+(?:\.\d{1,2})?$/.test(s)?Number(s):null;};
const image=(v:any):string|null=>{try{const u=new URL(text(v),"https://www.goofish.com");return /^https?:$/.test(u.protocol)?u.href:null;}catch{return null;}};
const iso=(v:any):string|null=>{const n=Number(v);return n>1e11&&n<1e14?new Date(n).toISOString():null;};

export function parseXianyuReply(plan:SitePlan, reply:XianyuReply):SiteResult {
  const p=plan.params;
  const result:SiteResult={version:1,operation:plan.operation,status:"ok",source:{url:reply.url,method:reply.method,checkedAt:reply.checkedAt},
    effective:{...p,cacheHit:!!reply.cached,execution:"page-sdk",requestedFilters:{minPrice:p.minPrice,maxPrice:p.maxPrice,sort:p.sort,personalOnly:p.personalOnly,freeShipping:p.freeShipping,newOnly:p.newOnly,region:p.region}},items:[],pagination:{next:null,hasMore:false},completeness:{scope:"requested-page",complete:true,reasons:[]}};
  const fail=(code:string,message:string):SiteResult=>{result.status=["LOGIN_REQUIRED","VERIFICATION_REQUIRED","ACCESS_BLOCKED","RATE_LIMITED"].includes(code)?"blocked":"error";result.error={code,message};result.completeness.complete=false;result.pagination.hasMore=null;return result;};
  const partial=(reason:string)=>{result.status="partial";result.completeness.complete=false;result.completeness.reasons.push(reason);};
  if(reply.state==="waiting") return fail("NOT_READY","闲鱼页面或读取请求仍在加载。");
  if(reply.error) return fail(reply.error.code,reply.error.message);
  const envelope=reply.data, ret=Array.isArray(envelope?.ret)?envelope.ret.join(";"):"";
  if(!ret) return fail("SCHEMA_CHANGED","闲鱼响应缺少业务状态，不能判定为空结果。");
  if(!envelope.ret.some((r:any)=>typeof r==="string"&&r.startsWith("SUCCESS::"))) {
    const code=/USER_VALIDATE|RGV587|ANTI_CREEP/.test(ret)?"VERIFICATION_REQUIRED":/SESSION|TOKEN|LOGIN/.test(ret)?"LOGIN_REQUIRED":/LIMIT|FREQUENT|TRAFFIC/.test(ret)?"RATE_LIMITED":/TIMEOUT/.test(ret)?"REQUEST_TIMEOUT":"SITE_REJECTED";
    return fail(code,`闲鱼拒绝读取：${ret.replace(/https?:\/\/\S+/g,"[验证链接]").slice(0,180)}`);
  }
  const data=envelope.data;
  if(plan.operation==="xianyu.regions") {
    if(!Array.isArray(data?.divisionArea)) return fail("SCHEMA_CHANGED","闲鱼地区列表结构发生变化。");
    result.items=data.divisionArea.map((d:any)=>({id:text(d.id),name:text(d.na),hasChildren:d.hasChild===true}));result.completeness.scope="region-children";
  } else if(plan.operation==="xianyu.search") {
    if(!Array.isArray(data?.resultList)||!data.resultInfo) return fail("SCHEMA_CHANGED","闲鱼响应缺少结果列表或搜索上下文。");
    const info=data.resultInfo, track=info.trackParams||{}, controls=info.searchResControlFields||{}, sqi=info.sqiControlFields||{};
    const decode=(s:string)=>{try{return decodeURIComponent(s.replace(/\+/g," "));}catch{return s;}};
    const echoed=sqi.userInputOriginalSearchKeywords||decode(text(track.q));
    if(echoed!==p.query||Number(track.page)!==p.page) return fail("RESULT_MISMATCH","结果的关键词或页码与本次搜索不一致，未返回旧结果。");
    if(controls.similar===true||sqi.forceEraseSearchKeywords===true) partial("网站返回了相似推荐或放宽关键词的结果，需要逐项核对。");
    const rows:Record<string,any>[]=[], seen=new Set<string>();let invalid=0,ads=0;
    for(const raw of data.resultList) {
      const main=raw?.data?.item?.main, c=main?.exContent, args=main?.clickParam?.args||{};
      if(c?.isAliMaMaAD||text(args.idle_search_adx)!==""&&text(args.idle_search_adx)!=="-1"&&text(args.idle_search_adx)!=="0") {ads++;continue;}
      const id=identifier(c?.itemId);
      if(!id||!Array.isArray(c?.price)||!text(c?.title)){invalid++;continue;}
      if(seen.has(id))continue;seen.add(id);
      const priceText=c.price.map((v:any)=>text(v.text)).join("");
      const tags=Object.values(c.fishTags||{}).flatMap((g:any)=>(g.tagList||[]).map((t:any)=>text(t.data?.content))).filter(Boolean);
      const displayPrice=price(priceText),abbreviated=/^[¥￥]?\d+(?:\.\d+)?万$/.test(priceText.replace(/\s/g,""));
      const exactPrice=displayPrice??(abbreviated?price(args.displayPrice??args.price):null);
      const serverTags=text(args.tag).split("/"),isNew=tags.includes("全新")||serverTags.includes("new");
      const usedCondition=tags.some(t=>/^(几乎全新|轻微使用痕迹|明显使用痕迹)$/.test(t));
      const item={id,title:text(c.title),price:exactPrice,priceText,priceBasis:displayPrice!==null?"visible-price":exactPrice!==null?"server-exact-price":"unparsed",currency:"CNY",priceType:"listing",url:`https://www.goofish.com/item?id=${id}`,
        image:image(c.picUrl),region:text(c.area)||null,seller:{name:text(c.userNickName)||null},publishedAt:iso(args.publishTime),tags,
        condition:{new:isNew&&!usedCondition?true:usedCondition&&!isNew?false:null,basis:isNew||usedCondition?"site-condition-tag":null},
        shipping:{free:tags.includes("freeShippingIcon")||serverTags.includes("freeship")?true:null},source:result.source};
      rows.push(item);
    }
    if(invalid) partial(`${invalid} 条结果无法确认商品结构，已跳过。`);
    if(data.resultList.length&&rows.length===0&&invalid) return fail("SCHEMA_CHANGED","列表存在但未能识别商品，不能报告没有结果。");
    const bounded=rows.filter(i=>(p.minPrice===undefined&&p.maxPrice===undefined)||(i.price!==null&&(p.minPrice===undefined||i.price>=p.minPrice)&&(p.maxPrice===undefined||i.price<=p.maxPrice)));
    const verification:Record<string,any>={price:{verified:(p.minPrice===undefined||Math.abs(Number(controls.minPrice)/100-p.minPrice)<0.02||p.minPrice===0&&Number(controls.minPrice)<=1)&&(p.maxPrice===undefined||Math.abs(Number(controls.maxPrice)/100-p.maxPrice)<0.02),basis:"server-price-bounds",returnedItemsInRange:bounded.length===rows.length},
      personalOnly:{verified:!p.personalOnly||sqi.filterPersonal===true,basis:"server-filterPersonal"},
      freeShipping:{verified:!p.freeShipping||rows.length>0&&rows.every(i=>i.shipping.free===true),basis:"returned-item-tags"},
      newOnly:{verified:!p.newOnly||rows.length>0&&rows.every(i=>i.condition.new===true),basis:"returned-item-tags"},
      region:{verified:!p.region||!!reply.regionEvidence&&rows.length>0&&rows.every(i=>i.region&&reply.regionEvidence!.allowedNames.includes(i.region)),basis:"site-region-hierarchy-and-returned-labels",scope:reply.regionEvidence?.scope||"not-confirmed",resolved:reply.regionEvidence?.resolved}};
    const order=p.sort==="latest"?rows.map(i=>i.publishedAt?Date.parse(i.publishedAt):null):rows.map(i=>i.price);
    const sorted=order.length>=2&&order.every((n,i)=>n!==null&&(i===0||(p.sort==="price_asc"?Number(order[i-1])<=n:Number(order[i-1])>=n)));
    result.effective.sortVerified=p.sort==="general"||["latest","price_asc","price_desc"].includes(p.sort)&&sorted;
    result.effective.filters=verification;result.effective.serverFilterString=reply.request?.propValueStr?.searchFilter||"";
    if(p.personalOnly||p.region)for(const row of rows)row.searchFilterEvidence={personalOnly:p.personalOnly?verification.personalOnly.verified:undefined,region:p.region?{requested:p.region,verified:verification.region.verified}:undefined,checkedAt:result.source.checkedAt};
    result.effective.pageVerified=true;result.effective.excludedAds=ads;result.effective.receivedCount=rows.length;
    if(!result.effective.sortVerified) partial("排序已请求，但当前页缺少足够证据确认顺序；未宣称全站排序已验证。");
    for(const [name,v] of Object.entries(verification)) if(!v.verified) partial(`${name} 已请求，响应证据尚不能确认完整生效。`);
    if(bounded.length!==rows.length) partial("价格条件未覆盖全部返回项，已在当前页再次过滤；不代表全站无匹配。");
    const end=p.itemOffset+p.limit;
    result.items=bounded.slice(p.itemOffset,end);
    const more=typeof info.hasNextPage==="boolean"?info.hasNextPage:typeof controls.nextPage==="boolean"?controls.nextPage:null;
    result.pagination=end<bounded.length?{hasMore:true,next:{...p,itemOffset:end,refresh:false}}:{hasMore:more,next:more&&p.page<50?{...p,page:p.page+1,itemOffset:0,refresh:false}:null};
    if(end<bounded.length) partial("本页仍有未返回商品，请使用 pagination.next 继续。");
    if(p.page===50&&more) partial("已到网页端 50 页上限，仍可能有未覆盖商品。");
    if(!result.items.length&&bounded.length===0&&rows.length>0) partial("本页没有符合价格条件的候选，不能据此判定全站没有商品。");
  } else {
    const d=data?.itemDO, seller=data?.sellerDO;
    if(!d||typeof d!=="object") return fail("SCHEMA_CHANGED","闲鱼详情缺少 itemDO；未将加载失败解释为下架。");
    if(identifier(d.itemId)!==p.id) return fail("RESULT_MISMATCH","详情商品 ID 与请求不符。");
    const description=text(d.desc||d.description), title=text(d.title)||description.split("\n")[0];
    if(!title&&!description) return fail("SCHEMA_CHANGED","商品详情没有可读标题或描述。");
    // Follow the page's price precedence: range, custom label, free item,
    // promotional price, then regular listing price. A promotion is not a sale.
    const range=d.minPrice&&d.maxPrice,custom=text(d.defaultPriceDesc),free=text(d.soldPrice)==="0",promotion=text(d.promotionPriceDO?.promotionPriceMin);
    const priceText=range?`${d.minPrice} - ${d.maxPrice}`:custom||(free?"免费送":promotion||text(d.soldPrice??d.price));
    const priceBasis=range?"price-range":custom?"custom-price-label":free?"free-item":promotion?"promotion-price":"listing-price";
    const attributes=(Array.isArray(d.cpvLabels)?d.cpvLabels:[]).map((a:any)=>({name:text(a.propertyName||a.name||a.label),value:text(a.valueName||a.value||a.text)})).filter((a:any)=>a.name||a.value);
    result.items=[{id:p.id,title,description,price:free&&!range&&!custom?0:price(priceText),priceText,priceBasis,currency:"CNY",priceType:"listing",url:`https://www.goofish.com/item?id=${p.id}`,
      promotion:promotion?{priceText:promotion,label:text(d.promotionPriceDO?.promotionPriceTag)||null,description:text(d.promotionPriceDO?.promotionDesc)||null,regularPrice:price(d.soldPrice)}:null,
      images:(Array.isArray(d.imageInfos)?d.imageInfos:[]).map((i:any)=>image(i.url)).filter(Boolean),attributes,
      condition:{new:attributes.find((a:any)=>a.name==="成色")?.value==="全新"?true:attributes.some((a:any)=>a.name==="成色"&&/几乎全新|使用痕迹/.test(a.value))?false:null,basis:"item-attributes"},
      shipping:{text:text(d.postage||d.shippingFee||d.freight)||null,free:null},status:{raw:d.itemStatusStr??d.itemStatus??null,label:({"在线":"available","已下架":"offline","卖掉了":"sold"} as Record<string,string>)[d.itemStatusStr]||"unknown"},
      seller:{id:identifier(seller?.sellerId),name:text(seller?.nick||seller?.userNick)||null,credit:text(seller?.zhimaLevelInfo?.levelName)||null},source:result.source}];
    result.completeness.scope="item-detail";
    result.effective.execution=reply.method;
    if(reply.method==="dom")partial("页面状态不可用，回退到当前商品可读 DOM；字段覆盖可能不完整。");
    if(!description) partial("未取得完整商品描述。");
    if(result.items[0].price===null) partial("标价无法解析为单一金额，保留原文待核实。");
  }
  if(p.criteria) for(const item of result.items) item.assessment=assessXianyuItem(item,p.criteria);
  if(!result.items.length&&result.status==="ok") result.status="empty";
  return result;
}

export async function runXianyuAdapter(input:SiteInput,transport:SiteTransport):Promise<SiteResult> {
  const plan=planSiteAdapter(input),start=Date.now();plan.access=transport.access;let calls=0;
  const evaluate=async(expression:string)=>{transport.check?.(plan.url);calls++;return transport.evaluate(expression);};
  transport.check?.(plan.url);transport.check?.("https://h5api.m.goofish.com");
  const current=await evaluate("({url:location.href})");
  let same=false;try {const c=new URL(current.url);same=c.origin===new URL(plan.url).origin;
    if(plan.operation==="xianyu.detail")same=same&&!plan.params.refresh&&c.pathname==="/item"&&c.searchParams.get("id")===plan.params.id;
  }catch{}
  if(!same){transport.check?.(plan.url);calls++;await transport.open(plan.url);}
  const readPlan=async(reading:SitePlan):Promise<XianyuReply>=>{
    reading.access=transport.access;const deadline=Date.now()+14000;let reply:XianyuReply;
    do {
      reply=await evaluate(reading.operation==="xianyu.detail"?`(${readXianyuDetailPage.toString()})(${JSON.stringify(reading)})`:`(${readXianyuPage.toString()})(${JSON.stringify(reading)},${JSON.stringify(transport.cacheScope||"")})`);
      if(!reply||!["ready","waiting","error"].includes(reply.state))throw new Error("闲鱼适配器未返回有效状态。");
      transport.check?.(reply.url);if(reply.state!=="waiting")break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }while(Date.now()<deadline);
    return reply.state==="waiting"?{...reply,state:"error",error:{code:"NOT_READY",message:"闲鱼页面尚未准备好，未重复导航或重放请求。"}}:reply;
  };
  let regionEvidence:XianyuReply["regionEvidence"],regionFailure:XianyuReply|undefined;
  if(plan.operation==="xianyu.search"&&plan.params.region){
    const requested=plan.params.region,resolved:Record<string,string>={};let parentId:string|undefined,children:Record<string,any>[]=[];
    const regionName=(name:string)=>name.replace(/[省市]$/u,"");
    for(const level of ["province","city","area"] as const){
      if(!requested[level])break;
      const regionPlan=planSiteAdapter({operation:"xianyu.regions",params:parentId?{parentId}:{}}),response=await readPlan(regionPlan),parsed=parseXianyuReply(regionPlan,response);
      if(!["ok","empty"].includes(parsed.status)){regionFailure={...response,state:"error",error:parsed.error||{code:"REGION_NOT_READY",message:"地区列表未能读取。"}};break;}
      const found=parsed.items.find(i=>regionName(i.name)===regionName(requested[level]));
      if(!found){regionFailure={...response,state:"error",error:{code:"REGION_NOT_FOUND",message:`地区层级中未找到 ${requested[level]}；请使用 xianyu.regions 的实际选项。`}};break;}
      resolved[level]=found.name;parentId=found.id;children=[];
      regionEvidence={scope:level,resolved,allowedNames:[found.name]};
      if(!found.hasChildren)break;
      if(level==="area"||!requested[level==="province"?"city":"area"]){
        const childPlan=planSiteAdapter({operation:"xianyu.regions",params:{parentId}}),childResponse=await readPlan(childPlan),childResult=parseXianyuReply(childPlan,childResponse);
        if(!["ok","empty"].includes(childResult.status)){regionFailure={...childResponse,state:"error",error:childResult.error||{code:"REGION_NOT_READY",message:"地区下级选项未能读取。"}};break;}
        children=childResult.items;regionEvidence.allowedNames.push(...children.map(i=>i.name));break;
      }
    }
    if(!regionFailure&&Object.keys(requested).some(k=>!resolved[k]))regionFailure={state:"error",url:plan.url,checkedAt:new Date().toISOString(),method:"browser-fetch",error:{code:"REGION_NOT_FOUND",message:"所选地区没有对应的下一级选项。"}};
  }
  const requestPlan=regionEvidence?{...plan,params:{...plan.params,region:regionEvidence.resolved}}:plan;
  const reply=regionFailure||{...await readPlan(requestPlan),regionEvidence};
  const result=parseXianyuReply(plan,reply);
  result.metrics={durationMs:Date.now()-start,browserCalls:calls,outputBytes:Buffer.byteLength(JSON.stringify(result))};
  return result;
}
