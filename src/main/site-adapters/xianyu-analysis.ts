import type { XianyuCriteria } from "./xianyu-schema";

export interface XianyuPriceRange { minPrice?: number; maxPrice?: number; freeShipping?:boolean; newOnly?:boolean; personalOnly?:boolean; region?:{province:string;city?:string;area?:string}; }
/** Seller text is evidence of a claim, never verification of condition or authenticity. */
export function assessXianyuItem(item: Record<string, any>, criteria?: XianyuCriteria, priceRange?: XianyuPriceRange) {
  const original = [item.title, item.description, ...(item.attributes || []).map((a: any) => `${a.name}: ${a.value}`),...(Array.isArray(item.tags)?item.tags:[])].filter(Boolean).join("\n");
  const text = original.normalize("NFKC").replace(/✖️?|×/g, "x");
  const facts: Record<string, { value: unknown; evidence: string; basis: string }> = {};
  const issues: { code: string; evidence: string }[] = [];
  const capture = (key: string, value: unknown, evidence: string) => { facts[key] = { value, evidence, basis: "seller-statement" }; };
  const snippets = text.split(/[\n。！!；;，,]/).map(s => s.trim()).filter(Boolean);
  const evidence = (r: RegExp) => snippets.find(s => r.test(s))?.slice(0,300);
  const generation = [...text.matchAll(/\bDDR\s*([345])\b/gi)].map(m=>`DDR${m[1]}`);
  if (new Set(generation).size === 1) capture("generation", generation[0], text.match(/\bDDR\s*[345]\b/i)![0]);
  const kits = [...text.matchAll(/\b(\d{1,4})\s*G(?:B)?\s*[*x]\s*(\d{1,2})\b/gi)];
  for(const m of text.matchAll(/\b(\d{1,2})\s*[*x]\s*(\d{1,4})\s*G(?:B)?\b/gi)) kits.push(Object.assign([m[0],m[2],m[1]],{index:m.index,input:m.input}) as RegExpExecArray);
  const configs = new Map(kits.map(m=>[`${m[1]}x${m[2]}`,m]));
  if (configs.size === 1) { const m = kits[0]; capture("pieces", Number(m[2]), m[0]); capture("totalGB", Number(m[1])*Number(m[2]), m[0]); }
  else if (configs.size > 1) issues.push({code:"MULTIPLE_CONFIGURATIONS", evidence:kits.map(m=>m[0]).join(" / ")});
  if (!facts.totalGB) { const capacities = [...text.matchAll(/\b(\d{1,4})\s*G(?:B)?\b/gi)];
    if (new Set(capacities.map(m=>m[1])).size === 1) capture("totalGB", Number(capacities[0][1]), capacities[0][0]); }
  const single = evidence(/单(?:条|根)/), kit = evidence(/套条|(?:两|2)\s*(?:条|根)(?:一起|打包|套装|出)|两条的价格/);
  if (kit && !facts.pieces) capture("pieces", 2, kit);
  if (single && !facts.pieces) capture("pieces", 1, single);
  if(!kits.length&&facts.pieces?.value===2&&facts.totalGB){
    const total=text.match(/(?:总(?:容量)?|合计|共)\s*(\d{1,4})\s*G(?:B)?/i);
    const perPiece=text.match(/(?:每|单)(?:条|根)\s*(\d{1,4})\s*G(?:B)?/i);
    if(total)capture("totalGB",Number(total[1]),total[0]);
    else if(perPiece)capture("totalGB",Number(perPiece[1])*2,`${perPiece[0]}；${kit}`);
    else delete facts.totalGB;
  }
  if (/笔记本|SO-?DIMM/i.test(text) && !/台式机/.test(text)) capture("formFactor", "laptop", evidence(/笔记本|SO-?DIMM/i)!);
  if (/台式机/.test(text) && !/笔记本|SO-?DIMM/i.test(text)) capture("formFactor", "desktop", evidence(/台式机/)!);
  for (const [code, regex] of [
    ["DEPOSIT", /定金|订金|预付款|尾款/], ["STARTING_PRICE", /起拍|起售|起步价|价格.*起|\d\s*元起/],
    ["UNIT_PRICE", /(?:标价|价格|售价).{0,12}(?:单根|单条|单个|单件)/],
    ["PACKAGING_ONLY", /仅(?:售|卖)?包装|只(?:售|卖)(?:盒|包装)|空盒|包装盒.{0,5}(?:单卖|单出)/],
    ["PARTS_OR_FAULTY", /仅配件|配件价|拆件卖|不通电|无法开\s*机|坏条|坏的|故障品/]
  ] as const) { const e=evidence(regex); if(e) issues.push({code,evidence:e}); }
  const repair = snippets.find(s => /维修|修过|拆修|返修|修复/.test(s) && !/无(?:拆无修|拆修|维修)|未(?:拆修|维修|修过)|没(?:有)?(?:修过|维修)|无修|不包.*维修/.test(s));
  const noRepair = evidence(/无拆无修|无拆修|无维修|未维修|没(?:有)?修过/);
  if (repair) { capture("repaired", true, repair); issues.push({code:"REPAIR_MENTIONED",evidence:repair}); }
  else if (noRepair) capture("repaired", false, noRepair);
  const checks: { condition: string; status: "match" | "mismatch" | "unknown"; evidence: string }[] = [];
  for (const word of criteria?.include || []) checks.push({condition:`包含 ${word}`, status:text.toLowerCase().includes(word.toLowerCase())?"match":"unknown",evidence:evidence(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i")) || "当前文字未提供依据"});
  for (const word of criteria?.exclude || []) checks.push({condition:`排除 ${word}`,status:text.toLowerCase().includes(word.toLowerCase())?"mismatch":"match",evidence:evidence(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i")) || "当前文字未出现；未检查隐藏信息"});
  for (const [key, value] of Object.entries(criteria?.memory || {})) {
    const fact=facts[key]; checks.push({condition:`${key} = ${value}`,status:!fact?"unknown":fact.value===value?"match":"mismatch",evidence:fact?.evidence || "没有明确规格"});
  }
  if (criteria?.excludeRepaired) checks.push({condition:"排除维修",status:!facts.repaired?"unknown":facts.repaired.value?"mismatch":"match",evidence:facts.repaired?.evidence || "未说明维修情况"});
  if (priceRange?.minPrice!==undefined||priceRange?.maxPrice!==undefined) {
    const numeric=typeof item.price==="number"&&Number.isFinite(item.price)&&item.price>=0;
    const inRange=numeric&&(priceRange.minPrice===undefined||item.price>=priceRange.minPrice)&&(priceRange.maxPrice===undefined||item.price<=priceRange.maxPrice);
    checks.push({condition:`挂牌价范围：${priceRange.minPrice??0} 至 ${priceRange.maxPrice??"不限"} 元`,status:!numeric?"unknown":inRange?"match":"mismatch",evidence:`当前读取标价：${item.priceText??item.price??"未提供"}；未包含另付运费。`});
  }
  if (["sold","offline","unavailable"].includes(item.status?.label)) checks.push({condition:"商品当前可购买",status:"mismatch",evidence:item.status.raw||"网站明确显示商品已售、下架或无法查看"});
  if(priceRange?.freeShipping)checks.push({condition:"包邮",status:item.shipping?.free===true?"match":item.shipping?.free===false?"mismatch":"unknown",evidence:item.shipping?.text||"按网站包邮标记核对；未提供标记时待确认"});
  if(priceRange?.newOnly)checks.push({condition:"全新",status:item.condition?.new===true?"match":item.condition?.new===false?"mismatch":"unknown",evidence:"依据网站成色属性或全新标记，仍属卖家声明"});
  if(priceRange?.personalOnly)checks.push({condition:"个人闲置",status:item.searchFilterEvidence?.personalOnly===true?"match":"unknown",evidence:"仅在网站响应确认个人闲置筛选时匹配"});
  if(priceRange?.region){const proof=item.searchFilterEvidence?.region;
    checks.push({condition:`地区：${Object.values(priceRange.region).join(" / ")}`,status:proof?.verified&&["province","city","area"].every(k=>proof.requested?.[k]===priceRange.region?.[k as keyof typeof priceRange.region])?"match":"unknown",evidence:"依据网站地区层级和列表位置核对；无法确认时保留为待确认"});}
  if (issues.some(i=>["DEPOSIT","STARTING_PRICE","UNIT_PRICE","PACKAGING_ONLY","PARTS_OR_FAULTY","MULTIPLE_CONFIGURATIONS"].includes(i.code))) checks.push({condition:"标价对应所需完整商品",status:"unknown",evidence:issues.map(i=>i.evidence).join("；")});
  return { verdict: checks.some(c=>c.status==="mismatch")?"mismatch":checks.some(c=>c.status==="unknown")?"needs_confirmation":checks.length?"matches_seller_description":"not_assessed",
    facts, issues, checks, verification: "仅核对卖家文字，未验证实物、真实性或最终成交价" };
}

export function compareXianyuItems(items: Record<string, any>[], criteria?: XianyuCriteria, priceRange?: XianyuPriceRange) {
  return items.map(item=>({id:item.id,title:item.title,url:item.url,price:item.price,priceText:item.priceText,shipping:item.shipping ?? null,
    source:item.source,assessment:assessXianyuItem(item,criteria,priceRange)}));
}
