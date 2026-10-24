import { readFileSync } from 'node:fs';
import { invalid } from './records';

export const debugMethods = ['debug','network','console','errors','trace','profiler'];
/** Shared by the extension CLI and Gateway engine. JSON is useful for headers and categories. */
export function parseDebugArgs(method:string,input:string[],initial:Record<string,any>={}):Record<string,any>{
  const args=[...input];let p={...initial};
  const sources=['--params','--params-file','--params-stdin'].filter(f=>args.includes(f));
  if(sources.length>1)invalid('Use one params source');
  if(sources.length){
    const flag=sources[0],at=args.indexOf(flag),value=flag==='--params-stdin'?undefined:args[at+1];
    if(flag!=='--params-stdin'&&!value)invalid(`${flag} requires a value`);
    const text=flag==='--params'?value!:readFileSync(flag==='--params-stdin'?0:value!,'utf8');
    let parsed;try{parsed=JSON.parse(text.replace(/^\uFEFF/,''));}catch{invalid('Invalid params JSON');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))invalid('params must be an object');
    p={...p,...parsed};args.splice(at,flag==='--params-stdin'?1:2);
  }
  const strings:Record<string,string>={'--filter':'filter','--type':'type','--method':'method','--status':'status','--level':'level','--body':'body','--content-type':'contentType','--content':'content','--output':'path','--id':'id'};
  const numbers:Record<string,string>={'--limit':'limit','--since':'since','--offset':'offset','--text-limit':'textLimit'};
  const bools:Record<string,string>={'--clear':'clear','--failed':'failed','--abort':'abort','--details':'details'};
  const positionals:string[]=[];
  while(args.length){
    const arg=args.shift()!;
    if(bools[arg])p[bools[arg]]=true;
    else if(arg==='--no-body')p.body=false;
    else if(strings[arg]||numbers[arg]){const value=args.shift();if(value===undefined)invalid(`${arg} requires a value`);p[strings[arg]||numbers[arg]]=numbers[arg]?Number(value):value;}
    else if(arg.startsWith('--'))invalid(`Unknown debug option ${arg}`);
    else positionals.push(arg);
  }
  if(method==='network'){
    if(positionals.length)p.action=positionals.shift();
    p.action??='requests';
    if(p.action==='har'){if(positionals.length)p.operation=positionals.shift();if(positionals.length)p.path=positionals.shift();}
    else if(p.action==='request'&&positionals.length)p.id=positionals.shift();
    else if(['route','unroute'].includes(p.action)&&positionals.length)p.url=positionals.shift();
    if(p.action==='route'&&p.status!==undefined)p.status=Number(p.status);
  }else if(['debug','trace','profiler'].includes(method)){
    if(positionals.length)p.action=positionals.shift();
    if(method!=='debug'&&positionals.length)p.path=positionals.shift();
  }
  if(positionals.length)invalid(`Unexpected debug arguments: ${positionals.join(' ')}`);
  return p;
}
