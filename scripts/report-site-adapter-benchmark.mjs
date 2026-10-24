import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2] || 'artifacts/site-adapters/benchmark-v1');
// Presentation-only equivalence: whitespace and typographic quotation marks.
// Do not normalize different words, ranks or IDs into matching content.
const normalize = s => String(s || '').normalize('NFKC').replace(/[“”「」]/g, '"').replace(/[‘’]/g, "'").replace(/[\s\u200b-\u200d\ufeff]/g, '');
function canonical(raw) {
  try {
    const u = new URL(raw); let query = '';
    const note = u.hostname.endsWith('xiaohongshu.com') && u.pathname.match(/^\/(?:explore|search_result|discovery\/item)\/([a-f0-9]{24})/);
    if (note) return 'xiaohongshu.com/note/' + note[1];
    if (u.hostname.endsWith('youtube.com')) query = '?v=' + u.searchParams.get('v');
    // Sogou redirect tokens identify the destination; retain them for equality.
    if (u.hostname === 'weixin.sogou.com') query = u.search;
    if (u.hostname === 'mp.weixin.qq.com') query = ['__biz', 'mid', 'idx', 'sn'].map(k => `${k}=${u.searchParams.get(k) || ''}`).join('&');
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + query;
  } catch { return ''; }
}
function evidence(report, item) {
  const wanted = canonical(item.url), title = normalize(item.title);
  const links = report.calls.filter(c => c.name === 'read_page' && c.result).flatMap(c => c.result.fast?.candidates || []);
  const match = links.find(c => canonical(c.href) === wanted && normalize(c.label).includes(title));
  if (match) return 'DOM title/link pair';
  const rows = report.calls.filter(c => c.name === 'site_read' && c.result).flatMap(c => c.result.items || []);
  if (rows.some(r => canonical(r.url) === wanted && normalize(r.title) === title)) return 'adapter result (needs independent pair)';
  return null;
}
const files = (await readdir(root)).filter(f => /-\d+-(generic|adapter)\.json$/.test(f));
const reports = await Promise.all(files.map(async f => JSON.parse(await readFile(path.join(root, f), 'utf8'))));
const pairs = [];
for (const generic of reports.filter(r => r.mode === 'generic')) {
  const adapter = reports.find(r => r.site === generic.site && r.round === generic.round && r.mode === 'adapter');
  if (!adapter) continue;
  for (const report of [generic, adapter]) {
    const items = report.result?.items || [];
    report.validation = { state: 'review-required', returned: items.length, distinct: new Set(items.map(i => canonical(i.url))).size,
      evidence: items.map(item => ({ title: item.title, url: item.url, proof: evidence(report, item) })) };
  }
  const a = generic.result?.items || [], b = adapter.result?.items || [];
  const equal = a.length === 5 && b.length === 5 && a.every(i => b.some(j => canonical(i.url) === canonical(j.url) && normalize(i.title) === normalize(j.title)));
  const anchored = generic.validation.evidence.every(e => e.proof === 'DOM title/link pair');
  const verified = equal && anchored && generic.validation.distinct === 5 && adapter.validation.distinct === 5 && !generic.error && !adapter.error;
  if (verified) { generic.validation.state = 'verified'; adapter.validation.state = 'verified-against-generic-DOM'; }
  const totalTokens = r => r.usage ? (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0) + (r.usage.output_tokens || 0) : null;
  const metric = r => ({ ms: r.elapsedMs, modelCalls: r.modelCalls, toolCalls: r.toolCalls, tokensIncludingCache: totalTokens(r), outputBytes: r.toolOutputBytes });
  const old = metric(generic), next = metric(adapter), change = {};
  for (const k of Object.keys(old)) change[k] = old[k] ? Number(((1 - next[k] / old[k]) * 100).toFixed(1)) : null;
  const reason = verified ? '相同五条结果且 DOM 可核验' : generic.error || adapter.error ? '至少一种方式未完成任务' : !equal ? '返回的五条结果不一致' : '缺少独立 DOM 标题/链接证据';
  pairs.push({ site: generic.site, round: generic.round, verified, reason, errors: { generic: generic.error || null, adapter: adapter.error || null }, sameFiveResults: equal, genericDomAnchored: anchored, generic: old, adapter: next, reductionPercent: change,
    genericValidation: generic.validation, adapterValidation: adapter.validation });
}
const median = values => { const a = [...values].sort((x,y) => x-y); return a.length ? (a[Math.floor((a.length - 1)/2)] + a[Math.ceil((a.length - 1)/2)])/2 : null; };
const bySite = [...new Set(pairs.map(p => p.site))].map(site => { const rows = pairs.filter(p => p.site === site), good = rows.filter(p => p.verified); return {
  site, pairs: rows.length, verifiedPairs: good.length,
  medianReductionPercent: Object.fromEntries(['ms','modelCalls','toolCalls','tokensIncludingCache','outputBytes'].map(k => [k, median(good.map(p => p.reductionPercent[k]))]))
}; });
const report = { generatedAt: new Date().toISOString(), platform: process.platform, models: [...new Set(reports.map(r => r.model))], runs: reports.length, failedRuns: reports.filter(r => r.error).length,
  methodology: '同一真实模型、同一浏览器登录态、已加载列表页，每站交换顺序；只统计两种方式返回相同 5 条且标题/链接可由通用 DOM 证据核对的配对。Token 包含缓存读取；耗时不含统一的初始导航。',
  limits: ['样本量小，不代表长期稳定性。', '这项测试比较列表提取；详情、评论、字幕另有功能验证。', '未测量功耗；未在 macOS 实机运行。', '不把工具缺失、内容不一致或无法独立核验的轮次计入提速。'], bySite, pairs };
await writeFile(path.join(root, 'comparison.json'), JSON.stringify(report, null, 2));
const csv = [['site','round','verified','generic_ms','adapter_ms','time_reduction_percent','generic_tokens_including_cache','adapter_tokens_including_cache','token_reduction_percent'],
  ...pairs.map(p => [p.site,p.round,p.verified,p.generic.ms,p.adapter.ms,p.reductionPercent.ms,p.generic.tokensIncludingCache,p.adapter.tokensIncludingCache,p.reductionPercent.tokensIncludingCache])].map(row => row.join(',')).join('\n');
await writeFile(path.join(root, 'comparison.csv'), csv + '\n');
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
await writeFile(path.join(root, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ProfilePilot 网站适配对照测试</title><style>body{max-width:1100px;margin:40px auto;padding:0 20px;font:16px/1.7 system-ui;color:#182c3c;background:#f4f7fa}table{border-collapse:collapse;width:100%;background:white}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}small{color:#586776}.ok{color:#067647}.review{color:#a44b00}details{background:white;padding:12px;margin-top:16px}pre{white-space:pre-wrap;word-break:break-word}h1{font-size:28px}</style><h1>网站适配：真实模型对照测试</h1><p>${escape(report.methodology)}</p><table><thead><tr><th>网站 / 轮次</th><th>内容核验</th><th>通用读取</th><th>适配器</th><th>耗时减少</th><th>Token 减少</th></tr></thead><tbody>${pairs.map(p => `<tr><td>${escape(p.site)} / ${p.round}</td><td class="${p.verified?'ok':'review'}">${p.verified?'相同 5 条，DOM 可核对':'需要复核，不计入结论'}</td><td>${(p.generic.ms/1000).toFixed(2)} 秒</td><td>${(p.adapter.ms/1000).toFixed(2)} 秒</td><td>${p.verified?p.reductionPercent.ms+'%':'—'}</td><td>${p.verified?p.reductionPercent.tokensIncludingCache+'%':'—'}</td></tr>`).join('')}</tbody></table><p><small>${report.limits.map(escape).join('<br>')}</small></p><details><summary>逐条证据与原始指标</summary><pre>${escape(JSON.stringify(report, null, 2))}</pre></details></html>`);
console.log(JSON.stringify({ pairs: pairs.length, verified: pairs.filter(p=>p.verified).length, bySite }, null, 2));
