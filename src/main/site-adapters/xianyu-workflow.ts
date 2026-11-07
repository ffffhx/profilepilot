import type { SiteInput, SiteResult } from "./catalog";
import { planSiteAdapter } from "./catalog";
import { xianyuSearchSchema } from "./xianyu-schema";
import { compareXianyuItems, assessXianyuItem } from "./xianyu-analysis";
import { z } from "zod";

export const xianyuScanSchema=z.object({search:xianyuSearchSchema,maxPages:z.number().int().min(1).max(10).default(1),detailLimit:z.number().int().min(0).max(10).default(5)}).strict();
export async function scanXianyu(input:unknown,read:(input:SiteInput)=>Promise<SiteResult>) {
  const options=xianyuScanSchema.parse(input);planSiteAdapter({operation:"xianyu.search",params:options.search});
  let params:Record<string,any>={...options.search,limit:30,itemOffset:0,refresh:true};
  const searches:SiteResult[]=[],details:SiteResult[]=[],candidates=new Map<string,Record<string,any>>();
  let stopped:string|undefined;
  for(let i=0;i<options.maxPages;i++) {
    const result=await read({operation:"xianyu.search",params});searches.push(result);
    if(["error","blocked"].includes(result.status)){stopped=result.error?.message||result.status;break;}
    for(const item of result.items) if(!candidates.has(item.id))candidates.set(item.id,item);
    if(!result.pagination.next)break;params={...result.pagination.next,refresh:true};
  }
  if(!stopped)for(const candidate of candidates.values()) {
    if(details.length>=options.detailLimit)break;
    if(assessXianyuItem(candidate,options.search.criteria,options.search).verdict==="mismatch")continue;
    const result=await read({operation:"xianyu.detail",params:{id:candidate.id,criteria:options.search.criteria}});details.push(result);
    if(result.status==="error"&&result.error?.code==="ITEM_UNAVAILABLE") {
      candidates.set(candidate.id,{...candidate,status:{label:"unavailable",raw:result.error.message},availabilitySource:result.source});continue;
    }
    if(["error","blocked"].includes(result.status)){stopped=result.error?.message||result.status;break;}
    const item=result.items.find(i=>i.id===candidate.id);
    if(item)candidates.set(candidate.id,{...candidate,...item,
      shipping:item.shipping?.free==null?{...item.shipping,free:candidate.shipping?.free??null,evidenceSource:candidate.source}:item.shipping,
      condition:item.condition?.new==null?candidate.condition:item.condition,searchSource:candidate.source});
  }
  const items=[...candidates.values()];
  for(const item of items)item.assessment=assessXianyuItem(item,options.search.criteria,options.search);
  const comparison=compareXianyuItems(items,options.search.criteria,options.search);
  return {version:1,at:new Date().toISOString(),status:stopped?"partial":searches.some(r=>r.status==="partial")||details.some(r=>["partial","error"].includes(r.status))?"partial":"ok",
    options,items,comparison,searches,details,stopped,coverage:{pagesRead:searches.filter(r=>!["error","blocked"].includes(r.status)).length,candidates:items.length,
      detailsRead:details.filter(r=>["ok","partial"].includes(r.status)).length,hasMore:searches.at(-1)?.pagination.hasMore??null},
    limitations:["商品信息与成色为卖家声明；挂牌价不等于成交价。","只比较本次读取的候选；缺少规格、维修说明或完整详情时标为待确认。",...(stopped?[stopped]:[])]};
}

export function xianyuReportHtml(report:any):string {
  const label=(value:string)=>value.replace(/^generation = /,"内存代际：").replace(/^totalGB = (\d+)$/,"总容量：$1 GB").replace(/^pieces = (\d+)$/,"数量：$1 条").replace(/^formFactor = laptop$/,"适用设备：笔记本").replace(/^formFactor = desktop$/,"适用设备：台式机");
  report={...report,comparison:(report.comparison||[]).map((row:any)=>({...row,assessment:{...row.assessment,checks:(row.assessment?.checks||[]).map((check:any)=>({...check,condition:label(String(check.condition||""))}))}}))};
  const escape=(v:any)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
  const issueNames:Record<string,string>={DEPOSIT:"定金或尾款",STARTING_PRICE:"起步价",UNIT_PRICE:"单件标价",PACKAGING_ONLY:"仅包装",PARTS_OR_FAULTY:"配件或故障描述",MULTIPLE_CONFIGURATIONS:"多种规格",REPAIR_MENTIONED:"提及维修"};
  const rows=(report.comparison||[]).map((i:any)=>`<tr><td><a href="${escape(/^https:\/\/www\.goofish\.com\/item\?id=\d+$/.test(i.url)?i.url:"#")}" target="_blank" rel="noreferrer">${escape(i.title)}</a><small>${escape(i.id)}</small><small>采集于 ${escape(i.source?.checkedAt||"未提供")}${i.source?.timeBasis==="source-local"?"（来源未注明时区）":""}</small></td><td>${escape(i.priceText||i.price)}<small>人民币 · 挂牌价</small></td><td>${escape(({mismatch:"不符合",needs_confirmation:"待确认",matches_seller_description:"符合卖家描述",not_assessed:"未设置条件"} as any)[i.assessment?.verdict])}</td><td>${(i.assessment?.checks||[]).map((c:any)=>`<p><b>${escape(c.condition)}：${escape(({match:"文字匹配",mismatch:"不匹配",unknown:"待确认"} as any)[c.status])}</b><br>${escape(c.evidence)}</p>`).join("")}${(i.assessment?.issues||[]).map((c:any)=>`<p>${escape(issueNames[c.code]||c.code)}：${escape(c.evidence)}</p>`).join("")}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>闲鱼商品对比</title><style>body{font:16px/1.65 system-ui;margin:40px auto;max-width:1200px;padding:0 24px;background:#f6f7f9;color:#1b2430}h1{margin-bottom:8px}table{border-collapse:collapse;width:100%;background:white}th,td{padding:16px;border-bottom:1px solid #dde2e7;text-align:left;vertical-align:top}th{background:#e9eef3}td:first-child{width:32%}small{display:block;color:#657386}a{color:#155e75}p{margin:0 0 8px}.note{padding:16px;background:#fff4d2;border-radius:8px;margin:20px 0}@media(max-width:700px){body{padding:12px;margin:8px}table{font-size:13px}td,th{padding:8px}}</style><h1>闲鱼商品对比</h1><p>${escape(report.options?.search?.query)} · ${escape(report.at)} · ${escape(report.coverage?.pagesRead)} 页 / ${escape(report.coverage?.candidates)} 个候选 / ${escape(report.coverage?.detailsRead)} 个详情</p><div class="note">${(report.limitations||[]).map(escape).join("<br>")}</div><table><thead><tr><th>商品与来源</th><th>标价</th><th>判断</th><th>依据与待确认项</th></tr></thead><tbody>${rows}</tbody></table><p>本次变化：${escape(report.history?.changes?.length??0)}；${escape(report.history?.coverage||"")}</p></html>`;
}
