import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Body, RequestRecord, limits, invalid, integer, string, bytes, short, headerMap, preview, requestPredicate, requestSummary, harEntry, opaqueId } from './records';

export interface DebugEvent { method: string; params?: any; sessionId?: string }
export interface DebugTransport {
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<any>;
  check(): void;
}
type Route = { id: string; url: string; match: RegExp; types: string[]; action: 'abort' | 'fulfill'; status: number; body: string; headers: Array<{name:string;value:string}> };
type LogRecord = { id: string; sequence: number; type: string; text: string; at: string; target: string; session: string; args?: any[]; stack?: any; url?: string; line?: number; column?: number };
/** One owned task's debug data. No global browser history, page injections or model calls. */
export class BrowserDebugSession {
  private target = '';
  private rootSession?: string;
  private active = false;
  private generation = 0;
  private domains = ['Network','Runtime','Log','Performance'];
  private targets = new Set<string>();
  private parents = new Map<string,string>();
  private frameTargets = new Map<string,string>();
  private initialFrames: DebugEvent[] = [];
  private work = new Set<Promise<unknown>>();
  private records: RequestRecord[] = [];
  private current = new Map<string,RequestRecord>();
  private logs: LogRecord[] = [];
  private exceptions: LogRecord[] = [];
  private sequence = 0;
  private dropped = 0;
  private logDropped = 0;
  private bodyBytes = 0;
  private routes: Route[] = [];
  private issues: string[] = [];
  private har?: { active: boolean; content: 'text'|'all'|'none'; entries: RequestRecord[]; omitted: number; reasons: string[]; startedAt:string };
  private trace?: { active: boolean; complete: boolean; events: any[]; bytes: number; dropped: number; reason?: string; done?: () => void };
  constructor(private transport: DebugTransport, private outputDir: string) {}
  setFrameSessions(events:DebugEvent[]):void { this.initialFrames=events; }
  bindTarget(target: string, rootSession?: string): void {
    if (this.target && (this.target !== target || this.rootSession !== rootSession)) this.suspend('target-changed');
    this.target = target; this.rootSession = rootSession;
  }
  private root(): string { return this.rootSession || ''; }
  private issue(error: unknown): void { this.issues.push(short(error instanceof Error ? error.message : error,500)); if(this.issues.length>20)this.issues.shift(); }
  private background(fn: () => Promise<unknown>): void {
    const promise = fn().catch(error=>this.issue(error)).finally(()=>this.work.delete(promise));
    this.work.add(promise);
  }
  private async send(method:string, params:Record<string,unknown> = {}, session = this.root()):Promise<any> {
    this.transport.check(); return this.transport.send(method,params,session || undefined);
  }
  private async initialize(session: string, generation: number, waiting=false): Promise<void> {
    const check = () => { this.transport.check(); if(!this.active || generation!==this.generation || !this.targets.has(session))throw Error('Debug target changed'); };
    try {
    for(const domain of this.domains) { check(); await this.send(`${domain}.enable`,domain==='Network'?{maxTotalBufferSize:16*1024*1024,maxResourceBufferSize:4*1024*1024}:{},session); }
    check();
    // Enable collection before a new iframe executes its first fetch. Resume in
    // finally even when a domain is unsupported, while ownership still permits it.
    await this.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]},session);
    check(); if(this.routes.length)await this.applyRoutes(session);
    } finally { if(waiting){check();await this.send('Runtime.runIfWaitingForDebugger',{},session);} }
  }
  async start(domains?: unknown):Promise<any> {
    if(domains!==undefined){
      if(!Array.isArray(domains)||!domains.length||domains.some(d=>!['Network','Runtime','Log','Performance'].includes(d)))invalid('debug domains: Network, Runtime, Log, Performance');
      this.domains=[...new Set([...(this.active?this.domains:[]),...domains])] as string[];
    }
    if(this.active){for(const session of this.targets)await this.initialize(session,this.generation);return this.status();}
    this.transport.check(); this.active=true; const generation=++this.generation;
    this.targets.add(this.root());
    try { await this.initialize(this.root(),generation);for(const event of this.initialFrames)this.event(event);await this.flush(); }
    catch(error){
      // Undo the startup pause policy before abandoning a still-owned target.
      for(const session of this.targets)try{await this.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]},session);await this.send('Runtime.runIfWaitingForDebugger',{},session);}catch(cleanup){this.issue(cleanup);}
      this.suspend('initialization-failed');throw error;
    }
    return this.status();
  }
  status() { return {active:this.active,target:this.target,domains:this.domains,targets:this.targets.size,requests:this.records.length,
    dropped:this.dropped,logDropped:this.logDropped,bodyBytes:this.bodyBytes,limits,issues:[...this.issues],
    recording:this.har?{active:this.har.active,entries:this.har.entries.length,omitted:this.har.omitted,reasons:[...this.har.reasons]}:undefined,
    tracing:this.trace?{active:this.trace.active,events:this.trace.events.length,dropped:this.trace.dropped,complete:this.trace.complete,reason:this.trace.reason}:undefined}; }
  suspend(reason:string):void {
    this.active=false; this.generation++; this.targets.clear(); this.parents.clear(); this.frameTargets.clear(); this.routes=[];
    for(const r of this.current.values())if(r.state==='pending'){r.state='interrupted';r.failure=reason;}
    this.current.clear();
    if(this.har?.active){this.har.active=false;this.har.reasons.push(reason);}
    if(this.trace?.active){this.trace.active=false;this.trace.complete=false;this.trace.reason=reason;this.trace.done?.();}
  }
  private async flush():Promise<void> {
    // A finite batch of network/iframe follow-ups; later events are another batch.
    for(let i=0;i<8&&this.work.size;i++)await Promise.allSettled([...this.work]);
  }
  private requestKey(session:string,id:string):string{return `${session}\0${id}`;}
  event(event:DebugEvent):void {
    const session=event.sessionId || '',p=event.params || {},method=event.method;
    if(!this.active || !this.targets.has(session))return;
    if(method==='Target.attachedToTarget' && p.targetInfo?.type==='iframe'){
      if(!this.targets.has(p.sessionId)){this.targets.add(p.sessionId);this.parents.set(p.sessionId,session);this.frameTargets.set(p.sessionId,p.targetInfo.targetId);const generation=this.generation;this.background(()=>this.initialize(p.sessionId,generation,p.waitingForDebugger===true));}return;
    }
    if(method==='Target.detachedFromTarget'){
      const removed=new Set<string>([p.sessionId]);
      for(const [child,parent] of this.parents)if(removed.has(parent))removed.add(child);
      for(const child of removed){this.targets.delete(child);this.parents.delete(child);this.frameTargets.delete(child);}
      for(const [key,r] of this.current)if(removed.has(r.session)){if(r.state==='pending'){r.state='interrupted';r.failure='frame-detached';}this.current.delete(key);}
      return;
    }
    if(method==='Fetch.requestPaused'){const generation=this.generation;this.background(()=>this.routeRequest(p,session,generation));return;}
    if(method==='Tracing.dataCollected' && this.trace?.active){
      for(const value of p.value || []){const size=bytes(value);if(this.trace.bytes+size>limits.traceBytes){this.trace.dropped++;this.trace.complete=false;}else{this.trace.events.push(value);this.trace.bytes+=size;}}return;
    }
    if(method==='Tracing.tracingComplete'){this.trace?.done?.();return;}
    if(method==='Runtime.consoleAPICalled'){
      this.log(this.logs,{type:short(p.type,32),text:(p.args||[]).map((v:any)=>preview(v)).join(' ').slice(0,16000),
        args:bytes(p.args||[])<32768?p.args:undefined,stack:p.stackTrace},session,p.timestamp);
    } else if(method==='Runtime.exceptionThrown'){
      const d=p.exceptionDetails||{};
      this.log(this.exceptions,{type:'error',text:short(d.exception?.description||d.text,16000),stack:d.stackTrace,url:d.url,line:d.lineNumber,column:d.columnNumber},session,p.timestamp);
    } else if(method==='Log.entryAdded'){
      const e=p.entry||{};this.log(this.logs,{type:short(e.level,32),text:short(e.text,16000),url:e.url,line:e.lineNumber,stack:e.stackTrace},session,e.timestamp);
    }
    if(!method.startsWith('Network.') || !p.requestId)return;
    const key=this.requestKey(session,p.requestId);
    let record=this.current.get(key);
    // An OOPIF navigation can start in its parent renderer and finish in the
    // new renderer. Match both request and frame IDs, never a bare request ID.
    if(!record && session!==this.root()){
      const frame=p.frameId||this.frameTargets.get(session),ancestors=new Set<string>();
      for(let parent=this.parents.get(session);parent!==undefined;parent=this.parents.get(parent))ancestors.add(parent);
      const prior=[...this.current.values()].find(r=>r.requestId===p.requestId&&r.frameId===frame&&r.type.toLowerCase()==='document'&&ancestors.has(r.session));
      if(prior){this.current.delete(this.requestKey(prior.session,prior.requestId));prior.session=session;this.current.set(key,prior);record=prior;
        if(method==='Network.requestWillBeSent'&&!p.redirectResponse)return;
      }
    }
    if(method==='Network.requestWillBeSent'){
      if(p.redirectResponse&&record){this.response(record,p.redirectResponse,p.timestamp);record.state='redirected';record.redirectTo=short(p.request?.url,8192);record.durationMs=Math.max(0,(p.timestamp-record.timestamp)*1000);record.body={status:'unavailable',reason:'redirect-response'};}
      record={id:opaqueId('net'),sequence:++this.sequence,generation:this.generation,requestId:p.requestId,session,target:this.target,frameId:p.frameId,
        url:short(p.request?.url,8192),method:short(p.request?.method,32),type:short(p.type||'Other',64),
        startedAt:new Date(Number.isFinite(p.wallTime)?p.wallTime*1000:Date.now()).toISOString(),timestamp:p.timestamp||0,
        requestHeaders:headerMap(p.request?.headers),postData:p.request?.postData===undefined?undefined:short(p.request.postData,65536),
        state:'pending',body:{status:'not-captured'}};
      this.records.push(record);this.current.set(key,record);
      if(this.har?.active){if(this.har.entries.length<limits.harEntries)this.har.entries.push(record);else this.har.omitted++;}
      this.trim();
    }else if(record){
      if(method==='Network.responseReceived')this.response(record,p.response,p.timestamp);
      else if(method==='Network.requestServedFromCache')record.fromCache=true;
      else if(method==='Network.loadingFailed'){record.state='failed';record.failure=short(p.errorText||p.blockedReason||'network-failure');record.durationMs=Math.max(0,((p.timestamp||record.timestamp)-record.timestamp)*1000);record.body={status:'unavailable',reason:record.failure};this.current.delete(key);}
      else if(method==='Network.loadingFinished'){
        record.state='complete';record.finishedAt=p.timestamp;record.durationMs=Math.max(0,(p.timestamp-record.timestamp)*1000);record.size=p.encodedDataLength;
        if(this.har?.active&&this.har.entries.includes(record)&&this.har.content!=='none'){
          if(this.har.content==='all'||/json|text|javascript|xml|svg|form-urlencoded/i.test(record.mimeType||'')){
            const generation=this.generation;const saved=record;this.background(()=>this.captureBody(saved,generation));
          }else record.body={status:'omitted',reason:'non-text-content'};
        }
        this.current.delete(key);
      }
    }
    if(method==='Network.responseReceived')this.trim();
  }
  private response(r:RequestRecord,p:any,time:number):void {
    r.status=p.status;r.statusText=short(p.statusText,256);r.responseHeaders=headerMap(p.headers);r.mimeType=short(p.mimeType,256);
    r.protocol=p.protocol;r.fromCache=Boolean(p.fromDiskCache||p.fromPrefetchCache||r.fromCache);r.fromServiceWorker=Boolean(p.fromServiceWorker);r.responseAt=time;r.timing=p.timing;
  }
  private trim():void {
    let size=this.records.reduce((sum,r)=>sum+bytes(requestSummary(r))+bytes(r.requestHeaders)+bytes(r.responseHeaders||{})+(r.postData?.length||0),0);
    while(this.records.length>limits.requests||size>limits.metadataBytes){const r=this.records.shift()!;size-=bytes(requestSummary(r))+bytes(r.requestHeaders)+bytes(r.responseHeaders||{})+(r.postData?.length||0);this.dropped++;
      if(this.current.get(this.requestKey(r.session,r.requestId))===r && !(this.har?.active&&this.har.entries.includes(r)))this.current.delete(this.requestKey(r.session,r.requestId));}
    this.recountBodies();
    if(this.har){
      const weight=(r:RequestRecord)=>bytes(requestSummary(r))+bytes(r.requestHeaders)+bytes(r.responseHeaders||{})+(r.postData?.length||0);
      let total=this.har.entries.reduce((sum,r)=>sum+weight(r),0);
      while(total>limits.metadataBytes){const r=this.har.entries.shift()!;total-=weight(r);this.har.omitted++;if(!this.records.includes(r)&&this.current.get(this.requestKey(r.session,r.requestId))===r)this.current.delete(this.requestKey(r.session,r.requestId));}
    }
  }
  private recountBodies():void { this.bodyBytes=[...new Set([...this.records,...(this.har?.entries||[]),...this.current.values()])].reduce((sum,r)=>sum+(r.body.status==='captured'?(r.body.bytes||0):0),0); }
  private log(list:LogRecord[],value:any,session:string,timestamp?:number):void {
    const safe={...value,stack:value.stack&&bytes(value.stack)<32768?value.stack:undefined};
    list.push({id:opaqueId('log'),sequence:++this.sequence,at:new Date(Number.isFinite(timestamp)?timestamp!:Date.now()).toISOString(),target:this.target,session,...safe});
    let size=list.reduce((n,r)=>n+bytes(r),0);
    while(list.length>limits.logs||size>limits.logBytes){size-=bytes(list.shift());this.logDropped++;}
  }
  private async captureBody(r:RequestRecord,generation=this.generation):Promise<void>{
    if(['captured','pending'].includes(r.body.status))return;
    if(r.state==='pending')return;
    if(r.generation!==generation||r.target!==this.target||!this.targets.has(r.session)||generation!==this.generation){r.body={status:'unavailable',reason:'target-or-session-changed'};return;}
    this.recountBodies();
    if((r.size||0)>limits.bodyBytes||this.bodyBytes>=limits.totalBodyBytes){r.body={status:'omitted',reason:'body-budget'};return;}
    r.body={status:'pending'};
    try{
      const result=await this.send('Network.getResponseBody',{requestId:r.requestId},r.session);
      if(generation!==this.generation)throw Error('control-changed');
      const text=String(result.body||''),base64Encoded=Boolean(result.base64Encoded),size=base64Encoded?Buffer.byteLength(text,'base64'):Buffer.byteLength(text);
      this.recountBodies();
      if(size>limits.bodyBytes||this.bodyBytes+size>limits.totalBodyBytes){r.body={status:'omitted',reason:'body-budget',bytes:size};return;}
      this.bodyBytes+=size;r.body={status:'captured',text,base64Encoded,bytes:size};
    }catch(error){r.body={status:'unavailable',reason:short(error instanceof Error?error.message:error,500)};}
  }
  private page<T extends {sequence:number}>(items:T[],p:any){
    const since=integer(p.since,0,Number.MAX_SAFE_INTEGER,'since'),limit=integer(p.limit,100,1000,'limit');
    if(!limit)invalid('limit must be greater than zero');
    const selected=items.filter(r=>r.sequence>since),result=selected.slice(0,limit);
    return {items:result,cursor:result.at(-1)?.sequence??this.sequence,hasMore:selected.length>result.length};
  }
  private async artifact(name:unknown,kind:string,data:unknown):Promise<string>{
    const filename=name===undefined?path.join(this.outputDir,`${kind}-${Date.now()}.${kind==='network'?'har':'json'}`):path.resolve(string(name,'path',32768));
    await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(data,null,2),{encoding:'utf8',mode:0o600,flag:'wx'});return filename;
  }
  async command(method:string,p:Record<string,any>={}):Promise<any>{
    this.transport.check();
    if(p.clear!==undefined&&typeof p.clear!=='boolean')invalid('clear must be boolean');
    const required=method==='network'?['Network']:['console','errors'].includes(method)?['Runtime','Log']:[];
    if(required.some(domain=>!this.domains.includes(domain)))await this.start([...this.domains,...required]);
    if(method==='debug'){
      if(p.action==='status')return this.status();
      if(p.action==='stop'){
        if(this.trace?.active)invalid('Stop trace/profiler before debug stop');
        if(this.har?.active)invalid('Stop HAR recording before debug stop');
        for(const session of this.targets){await this.send('Fetch.disable',{},session);await this.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]},session);await this.send('Network.disable',{},session);}
        this.suspend('debug-stopped');return this.status();
      }
      if(p.action!==undefined&&p.action!=='start')invalid('debug supports start, stop, status');
      return this.start(p.domains);
    }
    if(method==='console'||method==='errors'){
      if(!this.active)await this.start();
      const list=method==='console'?this.logs:this.exceptions;
      if(p.clear){if(typeof p.clear!=='boolean')invalid('clear must be boolean');list.length=0;return{cleared:true};}
      const filter=p.filter===undefined?'':string(p.filter,'filter'),level=p.level===undefined?'':string(p.level,'level',64).toLowerCase();
      const page=this.page(list.filter(r=>(!filter||r.text.includes(filter))&&(!level||r.type.toLowerCase()===level)),p);
      return{[method==='console'?'messages':'errors']:page.items.map(r=>({...r,args:p.details?r.args:undefined})),cursor:page.cursor,hasMore:page.hasMore,dropped:this.logDropped};
    }
    if(method==='trace'||method==='profiler')return this.traceCommand(p);
    if(method!=='network')invalid('Unsupported debug command');
    const action=p.action||'requests';
    if(action==='har')return this.harCommand(p);
    if(action==='routes')return{routes:this.routes.map(({match,...r})=>({...r,body:undefined}))};
    if(action==='route'||action==='unroute'){
      if(!this.active)await this.start();
      const previous=[...this.routes];
      if(action==='route'){
        const url=string(p.url,'url');if(!url)invalid('route URL is required');
        if(p.abort!==true&&typeof p.body!=='string')invalid('route needs abort:true or body:string');
        if(p.abort===true&&p.body!==undefined)invalid('abort and body cannot be combined');
        const body=p.body===undefined?'':string(p.body,'body',limits.bodyBytes),status=integer(p.status,200,599,'status');if(status<200)invalid('mock status must be 200..599');
        const escaped=url.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');
        if(this.routes.length>=50)invalid('Too many routes');
        this.routes.push({id:opaqueId('route'),url,match:new RegExp(`^${escaped}$`),types:p.type?string(p.type,'type',256).toLowerCase().split(',').map(v=>v.trim()):[],
          action:p.abort?'abort':'fulfill',status,body,headers:Object.entries(headerMap(p.headers||{'Content-Type':p.contentType||'application/json'})).map(([name,value])=>({name,value}))});
      }else{if(p.id!==undefined)string(p.id,'id');if(p.url!==undefined)string(p.url,'url');this.routes=this.routes.filter(r=>p.id?r.id!==p.id:p.url?r.url!==p.url:false);}
      try{for(const session of this.targets)await this.applyRoutes(session);}
      catch(error){this.routes=previous;for(const session of this.targets)try{await this.applyRoutes(session);}catch(rollback){this.issue(rollback);}throw error;}
      return{routes:this.routes.map(({match,body,...r})=>r)};
    }
    if(!['requests','request','clear'].includes(action))invalid('network supports requests, request, clear, route, unroute, routes, har');
    if(!this.active)await this.start();
    if(action==='clear'||p.clear===true){this.records=[];for(const [key,r] of this.current)if(!(this.har?.active&&this.har.entries.includes(r)))this.current.delete(key);this.recountBodies();this.dropped=0;return{cleared:true,harPreserved:Boolean(this.har?.active)};}
    if(action==='request'){
      const id=string(p.id,'id'),record=this.records.find(r=>r.id===id);if(!record)invalid('Unknown request ID; use the id returned by network requests');
      if(p.body!==false&&record.body.status==='not-captured')await this.captureBody(record);
      const offset=integer(p.offset,0,limits.bodyBytes*2,'offset'),length=integer(p.textLimit,16000,100000,'textLimit');
      const value=record.body.text||'',{session,...result}=record;
      return{...result,body:{...record.body,text:p.body===false?undefined:record.body.base64Encoded?undefined:value.slice(offset,offset+length),
        offset,totalCharacters:value.length,hasMore:!record.body.base64Encoded&&offset+length<value.length}};
    }
    const result=this.page(this.records.filter(requestPredicate(p)),p);
    return{requests:result.items.map(requestSummary),cursor:result.cursor,hasMore:result.hasMore,dropped:this.dropped,tracking:this.active};
  }
  private async applyRoutes(session:string):Promise<void>{
    if(this.routes.length)await this.send('Fetch.enable',{patterns:this.routes.map(r=>({urlPattern:r.url,requestStage:'Request'}))},session);
    else await this.send('Fetch.disable',{},session);
  }
  private async routeRequest(p:any,session:string,generation:number):Promise<void>{
    if(!this.active||generation!==this.generation)return;
    const route=[...this.routes].reverse().find(r=>r.match.test(p.request?.url||'')&&(!r.types.length||r.types.includes(String(p.resourceType).toLowerCase())));
    if(!route){await this.send('Fetch.continueRequest',{requestId:p.requestId},session);return;}
    if(route.action==='abort')await this.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'},session);
    else await this.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:route.status,responseHeaders:route.headers,body:Buffer.from(route.body).toString('base64')},session);
  }
  private async harCommand(p:any):Promise<any>{
    if(p.operation==='start'){
      if(this.har?.active)invalid('HAR recording already active');
      const content=p.content||'text';if(!['text','all','none'].includes(content))invalid('HAR content: text, all, none');
      if(!this.active)await this.start();
      this.har={active:true,content,entries:[],omitted:0,reasons:[],startedAt:new Date().toISOString()};
      for(const [key,r] of this.current)if(!this.records.includes(r))this.current.delete(key);
      this.recountBodies();return{started:true,content,limits};
    }
    if(p.operation!=='stop')invalid('network har requires start or stop');
    const har=this.har;if(!har)invalid('No HAR recording');
    har.active=false;await this.flush();
    const incomplete=har.entries.filter(r=>r.state==='pending'||r.state==='interrupted').length;
    const missingBodies=har.entries.filter(r=>r.body.status!=='captured').length;
    const log={version:'1.2',creator:{name:'ProfilePilot',version:'1'},entries:har.entries.map(r=>harEntry(har.content==='none'?{...r,body:{status:'omitted',reason:'content-disabled'}}:r)),
      _capture:{startedAt:har.startedAt,content:har.content,omitted:har.omitted,incomplete,missingBodies,reasons:har.reasons,limits}};
    const filename=await this.artifact(p.path,'network',{log});
    return{path:filename,entries:har.entries.length,omitted:har.omitted,incomplete,missingBodies,reasons:har.reasons,complete:!incomplete&&!har.omitted&&!har.reasons.length};
  }
  private async traceCommand(p:any):Promise<any>{
    if(p.action==='start'){
      if(this.trace?.active)invalid('Trace already active');
      if(!this.active)await this.start();
      const categories=p.categories||['devtools.timeline','v8.execute','blink.user_timing','disabled-by-default-v8.cpu_profiler'];
      if(!Array.isArray(categories)||categories.some(c=>typeof c!=='string'||c.length>128))invalid('categories must be strings');
      this.trace={active:true,complete:true,events:[],bytes:0,dropped:0};
      try{await this.send('Tracing.start',{transferMode:'ReportEvents',traceConfig:{recordMode:'recordContinuously',includedCategories:categories}});}catch(e){this.trace=undefined;throw e;}
      return{started:true,categories};
    }
    if(p.action!=='stop')invalid('trace/profiler requires start or stop');
    const trace=this.trace;if(!trace)invalid('No trace recording');
    if(trace.active){
      let timer:ReturnType<typeof setTimeout>;
      const done=new Promise<void>(resolve=>{timer=setTimeout(()=>{trace.complete=false;trace.reason='Trace completion timed out';resolve();},15000);trace.done=resolve;});
      try{await this.send('Tracing.end');await done;}catch(e){trace.complete=false;trace.reason=String(e);}finally{clearTimeout(timer!);trace.active=false;trace.done=undefined;}
    }
    const filename=await this.artifact(p.path,'trace',{traceEvents:trace.events,metadata:{complete:trace.complete,dropped:trace.dropped,reason:trace.reason}});
    return{path:filename,eventCount:trace.events.length,complete:trace.complete,dropped:trace.dropped,reason:trace.reason};
  }
}
