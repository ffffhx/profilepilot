import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { parseBrowserCliRoute } from "../browser-cli";
import { nativeControlRoot, requestNativeControl } from "../native-control/cli";
import { runGatewaySiteCli } from "./gateway-cli";
import { scanXianyu, xianyuReportHtml } from "./xianyu-workflow";
import { readXianyuHistory, recordXianyuScan, importGoofishHistory } from "./xianyu-history";
import { compareXianyuItems } from "./xianyu-analysis";
import { xianyuCriteria, xianyuSearchSchema } from "./xianyu-schema";
import { planSiteAdapter, type SiteInput, type SiteResult } from "./catalog";

export const xianyuCliHelp=`Xianyu workflows (uses the same already-owned browser session; never claims or resumes):
  ppilot browser --session TASK xianyu scan --params-file scan.json --store history.json --output report.json --html report.html
  ppilot browser xianyu history --store history.json [--item ITEM_ID]
  ppilot browser xianyu import --store history.json --input goofish-history.json
  ppilot browser xianyu compare --input report.json --params-file criteria.json [--html comparison.html]
scan.json: {"search":{"query":"DDR5 32GB","maxPrice":500,"criteria":{"excludeRepaired":true,"memory":{"generation":"DDR5","totalGB":32,"pieces":2}}},"maxPages":2,"detailLimit":5}
Each scan runs once. Reuse your existing task scheduler for repeated scans; the selected session must still be owned.
History is scoped to the Profile and search conditions. First scan establishes a baseline; missing items are never marked sold.
Import accepts the existing xianyu-monitor goofish.py history JSON export; it does not modify its SQLite database.
`;
export async function runXianyuCli(route:ReturnType<typeof parseBrowserCliRoute>,io:Pick<NodeJS.Process,"stdout"|"stderr">,env:NodeJS.ProcessEnv) {
  const tail=route.args.slice(route.commandIndex+1),verb=tail.shift();
  if(!verb||["help","--help"].includes(verb)){io.stdout.write(xianyuCliHelp);return 0;}
  const flags:Record<string,string>={};
  for(let i=0;i<tail.length;i+=2){const key=tail[i],value=tail[i+1];if(!["--params-file","--store","--output","--html","--input","--item"].includes(key)||!value||value.startsWith("--")||flags[key])throw new Error("无效或重复参数；使用 xianyu --help。");flags[key]=value;}
  const supported:Record<string,string[]>={scan:["--params-file","--store","--output","--html"],history:["--store","--item","--output"],import:["--store","--input","--output"],compare:["--input","--params-file","--output","--html"]};
  if(!supported[verb]||Object.keys(flags).some(k=>!supported[verb].includes(k)))throw new Error("命令或参数组合无效；使用 xianyu --help。");
  const paths=["--store","--output","--html","--input","--params-file"].filter(k=>flags[k]).map(k=>process.platform==="win32"?path.resolve(flags[k]).toLowerCase():path.resolve(flags[k]));
  if(new Set(paths).size!==paths.length)throw new Error("输入、历史、JSON 报告和 HTML 必须使用不同文件，避免相互覆盖。");
  const required=(key:string)=>{if(!flags[key])throw new Error(`需要 ${key}。`);return flags[key];};
  const json=(file:string)=>{const raw=readFileSync(file,"utf8");if(Buffer.byteLength(raw)>16*1024*1024)throw new Error("输入超过 16 MiB。");return JSON.parse(raw.replace(/^\uFEFF/,""));};
  const save=(file:string,data:string)=>{mkdirSync(path.dirname(path.resolve(file)),{recursive:true});writeFileSync(file,data,"utf8");};
  let result:any;
  if(verb==="history") {
    const data=readXianyuHistory(required("--store"));const id=flags["--item"];
    if(id&&!/^\d{1,30}$/.test(id))throw new Error("无效商品 ID。");
    result={version:1,priceType:"listing",watches:Object.entries(data.watches).map(([watchId,w])=>({watchId,scope:w.scope,query:w.query,initializedAt:w.initializedAt,lastScanAt:w.lastScanAt,observations:w.observations.filter(i=>!id||i.id===id)}))};
  } else if(verb==="import") result=importGoofishHistory(required("--store"),json(required("--input")));
  else if(verb==="compare") {
    const input=json(required("--input")),criteria=xianyuCriteria.parse(json(required("--params-file")));
    const items=Array.isArray(input)?input:input.items||input.result?.items;
    if(!Array.isArray(items)||items.length>300)throw new Error("需要最多 300 个候选商品。");
    const savedSearch=(input.result||input).options?.search;
    const search=savedSearch?xianyuSearchSchema.parse({...savedSearch,criteria}):undefined;
    if(search)planSiteAdapter({operation:"xianyu.search",params:search});
    const comparison=compareXianyuItems(items,criteria,search);
    result={at:new Date().toISOString(),comparison,items:items.map((item:any,index:number)=>({...item,assessment:comparison[index].assessment})),options:search?{search}:undefined,
      limitations:["离线核对输入文件中的卖家描述与原报告预算，未重新读取网站。"],coverage:{candidates:items.length}};
  } else if(verb==="scan") {
    const prefix=route.args.slice(0,route.commandIndex),get=(name:string)=>{const i=prefix.indexOf(name);return i<0?prefix.find(a=>a.startsWith(name+"="))?.slice(name.length+1):prefix[i+1];};
    const sessionId=get("--session")||env.PROFILEPILOT_SESSION;
    if(!sessionId)throw new Error("scan 需要显式 --session，使用已持有控制权的任务会话。");
    const root=get("--root")||nativeControlRoot();let scope=`gateway:${route.port}:${sessionId}`;
    const request=(method:string,params:Record<string,any>={})=>requestNativeControl({requestId:randomUUID(),sessionId,method,params},root);
    const guard=async()=>{if(route.connection!=="extension")return;
      const status=await request("status"),session=status.sessions?.find((s:any)=>s.sessionId===sessionId);
      if(!session||session.ownership!=="agent"||session.pauseReason)throw Object.assign(new Error("会话不再持有浏览器控制权；扫描停止，不自动恢复。"),{code:"NATIVE_USER_IN_CONTROL"});
      scope=session.profileId;
    };
    await guard();
    const read=async(input:SiteInput):Promise<SiteResult>=>{await guard();return route.connection==="extension"?request("site",input):runGatewaySiteCli([...prefix,"site","--params",JSON.stringify(input)],prefix.length,route.port,env) as Promise<SiteResult>;};
    result=await scanXianyu(json(required("--params-file")),read);
    if(flags["--store"]&&result.searches.some((r:SiteResult)=>["ok","partial","empty"].includes(r.status))) result.history=recordXianyuScan(flags["--store"],scope,result.options.search,result.searches);
  }else throw new Error("未知闲鱼命令；使用 xianyu --help。");
  if(flags["--output"])save(flags["--output"],JSON.stringify(result,null,2));
  if(flags["--html"]){if(!result.comparison)throw new Error("只有 scan / compare 可以生成 HTML。");save(flags["--html"],xianyuReportHtml(result));}
  io.stdout.write(JSON.stringify({ok:true,result})+"\n");return 0;
}
