import { randomUUID } from 'node:crypto';

export type Body = { status: 'not-captured' | 'pending' | 'captured' | 'unavailable' | 'omitted'; reason?: string; text?: string; base64Encoded?: boolean; bytes?: number };
export interface RequestRecord {
  id: string; sequence: number; generation: number; requestId: string; session: string; target: string; frameId?: string;
  url: string; method: string; type: string; startedAt: string; timestamp: number;
  requestHeaders: Record<string, string>; postData?: string; status?: number; statusText?: string;
  responseHeaders?: Record<string, string>; mimeType?: string; protocol?: string;
  state: 'pending' | 'complete' | 'failed' | 'redirected' | 'interrupted'; failure?: string;
  fromCache?: boolean; fromServiceWorker?: boolean; durationMs?: number; size?: number;
  timing?: Record<string, number>; responseAt?: number; finishedAt?: number; redirectTo?: string; body: Body;
}
export const limits = { requests: 2000, metadataBytes: 16 * 1024 * 1024, logs: 1000, logBytes: 4 * 1024 * 1024,
  bodyBytes: 2 * 1024 * 1024, totalBodyBytes: 32 * 1024 * 1024, harEntries: 5000, traceBytes: 32 * 1024 * 1024 };
export function invalid(message: string): never { throw Object.assign(new Error(message), { code: 'NATIVE_INVALID_REQUEST' }); }
export function integer(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) invalid(`${name} must be an integer from 0 to ${max}`);
  return Number(value);
}
export function string(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) invalid(`${name} must be a string of at most ${max} characters`);
  return value;
}
export function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value) ?? ''); }
export function short(value: unknown, max = 4096): string { return String(value ?? '').slice(0, max); }
export function headerMap(value: any): Record<string, string> {
  return Object.fromEntries(Object.entries(value || {}).slice(0, 200).map(([k,v]) => [short(k,256), short(v,8192)]));
}
export function statusMatcher(input: unknown): (status?: number) => boolean {
  if (input === undefined) return () => true;
  const text = String(input);
  let lo: number, hi: number;
  if (/^[1-5]\d\d$/.test(text)) lo = hi = Number(text);
  else if (/^[1-5]xx$/i.test(text)) { lo = Number(text[0])*100; hi = lo+99; }
  else if (/^[1-5]\d\d-[1-5]\d\d$/.test(text)) [lo,hi] = text.split('-').map(Number);
  else return invalid('status must be 200, 4xx or 400-599');
  if (lo! > hi!) invalid('status range is reversed');
  return status => status !== undefined && status >= lo! && status <= hi!;
}
export function requestPredicate(p: Record<string, any>): (r: RequestRecord) => boolean {
  const status = statusMatcher(p.status);
  const filter = p.filter === undefined ? '' : string(p.filter, 'filter');
  const method = p.method === undefined ? '' : string(p.method, 'method',32).toUpperCase();
  const types = p.type === undefined ? [] : string(p.type,'type',256).toLowerCase().split(',').map(v=>v.trim());
  if (p.failed !== undefined && typeof p.failed !== 'boolean') invalid('failed must be boolean');
  return r => (!filter || r.url.includes(filter)) && (!method || r.method.toUpperCase() === method) &&
    (!types.length || types.includes(r.type.toLowerCase())) && status(r.status) &&
    (p.failed === undefined || (r.state === 'failed' || (r.status ?? 0) >= 400) === p.failed);
}
/** Format protocol previews, never evaluate page code or invoke object getters. */
export function preview(value: any, depth = 0): string {
  if (!value || depth > 3) return '…';
  if (value.unserializableValue !== undefined) return short(value.unserializableValue);
  if (Object.hasOwn(value, 'value')) return typeof value.value === 'string' ? short(value.value) : short(JSON.stringify(value.value));
  if (value.type === 'undefined') return 'undefined';
  if (value.subtype === 'null') return 'null';
  const p = value.preview;
  if (p?.properties && !['map','set','weakmap','weakset'].includes(p.subtype)) {
    const array = value.subtype === 'array' || p.subtype === 'array';
    const properties = p.properties.slice(0,20).map((v:any) => {
      const text = v.valuePreview ? preview({ preview:v.valuePreview, subtype:v.subtype },depth+1) :
        v.type === 'string' ? JSON.stringify(short(v.value,256)) : short(v.value ?? v.type,256);
      return array ? text : `${short(v.name,128)}: ${text}`;
    });
    if (p.overflow || p.properties.length > 20) properties.push('…');
    return `${array?'[':'{'}${properties.join(', ')}${array?']':'}'}`;
  }
  return short(value.description || value.className || value.type);
}
export function requestSummary(r: RequestRecord) {
  const { requestHeaders, responseHeaders, postData, timing, body, session, timestamp, responseAt, finishedAt, ...summary } = r;
  return { ...summary, body: { ...body, text: undefined } };
}
const headers = (h: Record<string,string> = {}) => Object.entries(h).map(([name,value])=>({name,value}));
export function harEntry(r: RequestRecord) {
  let queryString: Array<{name:string;value:string}> = [];
  try { queryString = [...new URL(r.url).searchParams].map(([name,value])=>({name,value})); } catch {}
  const duration = Math.max(0,r.durationMs || 0), timing = r.timing;
  const send = timing && timing.sendEnd >= timing.sendStart ? timing.sendEnd-timing.sendStart : 0;
  const wait = r.responseAt !== undefined ? Math.max(0,(r.responseAt-r.timestamp)*1000-send) : 0;
  const receive = Math.max(0,duration-send-wait);
  const content: any = { size:r.body.bytes ?? r.size ?? 0, mimeType:r.mimeType || 'application/octet-stream' };
  if (r.body.status === 'captured') { content.text = r.body.text; if (r.body.base64Encoded) content.encoding = 'base64'; }
  return { startedDateTime:r.startedAt, time:duration,
    request:{method:r.method,url:r.url,httpVersion:r.protocol || '',headers:headers(r.requestHeaders),cookies:[],queryString,headersSize:-1,
      bodySize:r.postData ? Buffer.byteLength(r.postData) : 0, ...(r.postData ? {postData:{mimeType:r.requestHeaders['Content-Type'] || r.requestHeaders['content-type'] || '',text:r.postData}} : {})},
    response:{status:r.status || 0,statusText:r.statusText || '',httpVersion:r.protocol || '',headers:headers(r.responseHeaders),cookies:[],content,
      redirectURL:r.redirectTo || '',headersSize:-1,bodySize:r.size ?? -1},cache:{},timings:{send,wait,receive},
    _id:r.id,_requestId:r.requestId,_target:r.target,_frameId:r.frameId,_state:r.state,_failure:r.failure,
    _body:{status:r.body.status,reason:r.body.reason},_fromCache:r.fromCache,_fromServiceWorker:r.fromServiceWorker };
}
export function opaqueId(prefix: string): string { return `${prefix}-${randomUUID()}`; }
