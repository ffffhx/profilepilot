import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SiteResult } from "./catalog";
import { assessXianyuItem } from "./xianyu-analysis";

interface Observation { id:string; title:string; url:string; price:number|null; priceText:string; at:string; originalAt?:string; timeBasis?:"utc"|"source-local"|"date-only"; publishedAt?:string; currency:"CNY"; priceType:"listing"; configuration:string; }
interface Watch { scope:string; query:Record<string,unknown>; initializedAt:string; lastScanAt:string; latest:Record<string,Observation>; observations:Observation[]; }
export interface XianyuHistory { version:1; watches:Record<string,Watch>; }
export interface XianyuChange { kind:"new_listing"|"first_seen"|"price_drop"|"price_rise"|"listing_changed"; id:string; url:string; title:string; at:string; publishedAt?:string; previousPrice?:number|null; price:number|null; }

function timestamp(value:unknown,allowUnknownZone:boolean):Pick<Observation,"at"|"originalAt"|"timeBasis"> {
  if(typeof value!=="string")throw new Error("快照缺少有效采集时间。");
  const originalAt=value.trim();
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(originalAt);
  const local=/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(originalAt);
  const zoned=/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(originalAt);
  const normalized=originalAt.replace(" ","T");
  // Validate without ever interpreting an unzoned source time in the host's timezone.
  const calendar=normalized.slice(0,10),day=Date.parse(calendar+"T00:00:00Z");
  const parsed=Date.parse(dateOnly?normalized+"T00:00:00Z":local?normalized+"Z":normalized);
  if((!zoned&&!(allowUnknownZone&&(dateOnly||local)))||!Number.isFinite(parsed)||!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==calendar||(!dateOnly&&Number(normalized.slice(11,13))>23))throw new Error("采集时间无效或缺少时区；实时快照必须包含时区。");
  if(zoned)return {at:new Date(parsed).toISOString(),originalAt,timeBasis:"utc"};
  return {at:normalized,originalAt,timeBasis:dateOnly?"date-only":"source-local"};
}
function observation(item:Record<string,any>, at:string,allowUnknownZone=false):Observation {
  if(!/^\d{1,30}$/.test(item.id)) throw new Error("快照缺少有效商品 ID。");
  const facts=assessXianyuItem(item).facts;
  let publishedAt:string|undefined;
  if(typeof item.publishedAt==="string")try{publishedAt=timestamp(item.publishedAt,false).at;}catch{/* Unparseable publish time cannot establish a new listing. */}
  return {id:item.id,title:String(item.title||""),url:`https://www.goofish.com/item?id=${item.id}`,price:typeof item.price==="number"&&Number.isFinite(item.price)&&item.price>=0?item.price:null,
    priceText:String(item.priceText??item.price??""),...timestamp(at,allowUnknownZone),publishedAt,currency:"CNY",priceType:"listing",
    configuration:JSON.stringify({generation:facts.generation?.value,totalGB:facts.totalGB?.value,pieces:facts.pieces?.value,formFactor:facts.formFactor?.value,
      identityText:String(item.title||"").normalize("NFKC").trim(),issues:assessXianyuItem(item).issues.map(i=>i.code).sort()})};
}
export function readXianyuHistory(file:string):XianyuHistory {
  if(!existsSync(file)) return {version:1,watches:{}};
  if(readFileSync(file).byteLength>32*1024*1024) throw new Error("历史超过 32 MiB，请另建存储文件并保留原历史。");
  const data=JSON.parse(readFileSync(file,"utf8").replace(/^\uFEFF/,""));
  if(data.version!==1||!data.watches||typeof data.watches!=="object"||Array.isArray(data.watches)) throw new Error("历史格式无效，未覆盖原文件。");
  for(const w of Object.values(data.watches) as any[]) if(!w||!Array.isArray(w.observations)||!w.latest||typeof w.scope!=="string") throw new Error("历史记录损坏，未覆盖原文件。");
  return data;
}
function update(file:string,change:(data:XianyuHistory)=>any) {
  const target=path.resolve(file);mkdirSync(path.dirname(target),{recursive:true});const lock=target+".lock",temporary=target+"."+randomUUID()+".tmp";
  try {writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:"wx",mode:0o600});} catch {throw new Error("历史正在被另一进程更新；未覆盖、未重复记录。若进程已退出，请核查锁文件后处理。");}
  try {const data=readXianyuHistory(target),result=change(data);const serialized=JSON.stringify(data,null,2);
    if(Buffer.byteLength(serialized)>32*1024*1024)throw new Error("历史达到 32 MiB 上限，请归档后使用新文件。");
    writeFileSync(temporary,serialized,{flag:"wx",mode:0o600});renameSync(temporary,target);return result;
  }finally{rmSync(temporary,{force:true});rmSync(lock,{force:true});}
}
export function recordXianyuScan(file:string,scope:string,query:Record<string,unknown>,results:SiteResult[]) {
  const successful=results.filter(r=>["ok","partial","empty"].includes(r.status)&&r.operation==="xianyu.search");
  if(!successful.length) throw new Error("没有成功搜索结果；失败或验证拦截不会建立基线。");
  const stable=Object.fromEntries(Object.entries(query).filter(([k])=>!["page","itemOffset","limit","refresh"].includes(k)).sort(([a],[b])=>a.localeCompare(b)));
  const key=createHash("sha256").update(JSON.stringify([scope,stable])).digest("hex");
  return update(file,data=>{
    const at=successful.map(r=>timestamp(r.source.checkedAt,false).at).sort().at(-1)!, baseline=!data.watches[key];
    const previousScanAt=data.watches[key]?.lastScanAt;
    const w=data.watches[key] ||= {scope,query:stable,initializedAt:at,lastScanAt:at,latest:{},observations:[]};
    const changes:XianyuChange[]=[],seen=new Set<string>();let inserted=0;
    for(const r of successful) for(const item of r.items) {
      if(seen.has(item.id))continue;seen.add(item.id);
      const next=observation(item,item.source?.checkedAt||r.source.checkedAt),previous=w.latest[next.id];
      if(previousScanAt&&next.at<previousScanAt||previous&&next.at<=previous.at)continue;
      w.observations.push(next);inserted++;
      let kind:XianyuChange["kind"]|undefined;
      if(!baseline&&!previous)kind=next.publishedAt&&next.publishedAt>w.lastScanAt&&next.publishedAt<=next.at?"new_listing":"first_seen";
      else if(previous&&previous.configuration!==next.configuration)kind="listing_changed";
      else if(previous&&previous.price!==null&&next.price!==null&&next.price!==previous.price)kind=next.price<previous.price?"price_drop":"price_rise";
      if(kind)changes.push({kind,id:next.id,title:next.title,url:next.url,at:next.at,publishedAt:next.publishedAt,previousPrice:previous?.price,price:next.price});
      w.latest[next.id]=next;
    }
    if(at>w.lastScanAt)w.lastScanAt=at;
    return {watchId:key,baseline,inserted,changes,coverage:"仅本次成功读取的搜索页；首次出现不等于新上架，仅发布时间晚于上次扫描且不晚于本次采样时标为新上架；未出现的商品不推断为已售或下架",store:path.resolve(file)};
  });
}

/** Accepts the existing xianyu-monitor goofish.py history JSON export. */
export function importGoofishHistory(file:string,input:any) {
  if(!Array.isArray(input?.observations)) throw new Error("需要 goofish.py history 导出的 observations。");
  const imported=input.observations.map((r:any)=>{
    if(r.price_type!=="listing"||r.currency!=="CNY"||r.market!=="CN") throw new Error("仅接收中国市场 CNY 挂牌价，不能混入成交价或其他币种。");
    if(typeof r.price!=="number"||!Number.isFinite(r.price)||r.price<0)throw new Error("历史挂牌价必须是有效的非负数值。");
    return observation({id:String(r.item_id||String(r.product_id||"").replace(/^goofish:/,"")),title:r.series,url:r.source_url,price:typeof r.price==="number"?r.price:NaN},r.collected_at||r.date,true);
  });
  return update(file,data=>{
    const w=data.watches["import:ai-goofish-monitor"] ||= {scope:"external:ai-goofish-monitor",query:{source:"price_snapshots"},initializedAt:new Date().toISOString(),lastScanAt:new Date().toISOString(),latest:{},observations:[]};
    const keys=new Set(w.observations.map(r=>JSON.stringify([r.id,r.at,r.price])));let inserted=0;
    for(const r of imported) {const key=JSON.stringify([r.id,r.at,r.price]);if(keys.has(key))continue;keys.add(key);w.observations.push(r);inserted++;}
    const bases=new Map<string,Set<string>>();w.latest={};
    for(const r of w.observations){const set=bases.get(r.id)||new Set<string>();set.add(r.timeBasis||"utc");bases.set(r.id,set);
      if(!w.latest[r.id]||w.latest[r.id].at<r.at)w.latest[r.id]=r;}
    const ambiguousItems=[...bases].filter(([,v])=>v.size>1).map(([id])=>id);
    for(const id of ambiguousItems)delete w.latest[id];
    w.lastScanAt=new Date().toISOString();return {inserted,total:w.observations.length,ambiguousItems,source:"ai-goofish-monitor price_snapshots",coverage:"保留已有采样时间；无时区数据保留原始时间并标注，不按本机时区换算；混合时间口径不推断最新记录；导入不触发新上架或降价提醒"};
  });
}
