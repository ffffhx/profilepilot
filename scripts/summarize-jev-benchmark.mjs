import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const summary = JSON.parse(await readFile(path.join(root, 'summary.json'), 'utf8'));
const cells = await Promise.all(summary.results.map(r => readFile(path.join(root, r.file), 'utf8').then(JSON.parse)));
const runStatus = await readFile(path.join(root,'run-status.json'),'utf8').then(JSON.parse).catch(()=>null);
const median = xs => { const s=[...xs].sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null; };
const seconds = x => x===null?'—':(x/1000).toFixed(1);
const diagnosis = r => r.processFailure ? '运行时异常；输出格式不符；记录恢复' : /Session 不属于|GATEWAY_|PROFILE_LEASE|AGENT_USER_IN_CONTROL/.test(JSON.stringify(r.toolCalls)) ? '连接/会话异常' : r.status==='completed' && r.grade!=='pass' ? '完成声明未通过验收' : r.status==='waiting_user' ? '请求人工，未救场' : r.status==='paused' ? '暂停/达到限制' : r.grade==='pass' ? '通过' : '未完成';
const rows = summary.manifest.tasks.map(t => {
  const all = cells.filter(r=>r.taskId===t.id), d=all.filter(r=>r.mode==='driver'), a=all.filter(r=>r.mode==='advisory');
  const dp=d.filter(r=>r.grade==='pass'), ap=a.filter(r=>r.grade==='pass');
  const dm=median(dp.map(r=>r.elapsedMs)),am=median(ap.map(r=>r.elapsedMs));
  const paired=d.flatMap(r=>{const other=a.find(x=>x.round===r.round);return r.grade==='pass'&&other?.grade==='pass'?[{round:r.round,driverMs:r.elapsedMs,advisoryMs:other.elapsedMs,reductionPct:(1-r.elapsedMs/other.elapsedMs)*100}]:[];});
  return {id:t.id,name:t.name,driver:{count:d.length,passed:dp.length,medianMs:dm,fallback:d.filter(r=>r.fallback).length},advisory:{count:a.length,passed:ap.length,medianMs:am},paired,pairMedianReductionPct:median(paired.map(p=>p.reductionPct))};
});
const totals=Object.fromEntries(['driver','advisory'].map(mode=>{const all=cells.filter(r=>r.mode===mode);return [mode,{runs:all.length,passed:all.filter(r=>r.grade==='pass').length,fallback:all.filter(r=>r.fallback).length,jevActions:all.reduce((s,r)=>s+(r.usage.jevActions||0),0),jevCalls:all.reduce((s,r)=>s+(r.usage.jev?.calls||0),0),helperCalls:all.reduce((s,r)=>s+(r.usage.helper?.calls||0),0),sdkEstimatedUsd:all.reduce((s,r)=>s+r.usage.costUsd,0),infrastructureFailures:all.filter(r=>diagnosis(r)==='连接/会话异常').length,unverifiedCompletions:all.filter(r=>r.status==='completed'&&r.grade!=='pass').length}];}));
const table=rows.map(r=>`| ${r.id} ${r.name} | ${r.driver.passed}/${r.driver.count} | ${seconds(r.driver.medianMs)} | ${r.advisory.passed}/${r.advisory.count} | ${seconds(r.advisory.medianMs)} | ${r.driver.fallback}/${r.driver.count} | ${r.pairMedianReductionPct===null?'—':r.pairMedianReductionPct.toFixed(1)+'%'}（${r.paired.length} 对） |`).join('\n');
const trialTable=cells.map(r=>`| ${r.taskId} | ${r.round} | ${r.mode} | ${r.grade} / ${r.status} | ${r.elapsedCensored ? "≥240（中断）" : seconds(r.elapsedMs)} | ${r.usage.jevActions||0} | ${r.usage.helper?.calls||0} | ${r.fallback?'是':'否'} | ${diagnosis(r)} | [JSON](${r.file}) |`).join('\n');
const report=`# Jev 优先执行 × Garden Lab 原任务复测\n\n运行批次：${summary.manifest.runId}。已完成 ${cells.length}/${summary.planned} 次。\n\n## 条件与口径\n\n复用文章《浏览器 Agent 工具怎么选》对应的六张原任务卡和原页面：T05、T06、T08、T15、T18、T20。题目逐字复用，原文不会改写为本次结果。三轮、两种模式，共 36 次计划执行。\n\n- 主模型：${summary.manifest.model}；Jev：${summary.manifest.jevProvider}；Windows、同一已启动的真实 Chrome 独立测试 Profile，Gateway 端口 ${summary.manifest.port}。\n- 每次新建任务存储及 SDK 会话，清空靶场服务端测试登录态；从相同首页开始，模式顺序交替，任务顺序每轮轮换。附件仅预先选定原任务的 upload-token.txt。\n- 两组使用相同题目、授权、时间/动作/SDK 费用上限。每任务最多 4 分钟、35 次操作、SDK 估算费用上限 0.6 美元。准备首页与独立验收不计时；任务执行、SDK 收尾与释放计时。\n- 成功要求：Agent 报告 completed、答案符合原标准、独立页面状态及请求记录符合原标准。JSON 提取逐项验证 12 件商品的名称、数字价格、库存和排序；上传验证实际 File 对象。验收答案和源码没有传给模型。\n- 失败、超时、人工请求保留，不人工救场，不把失败快速退出算作提速。成功耗时只对成功样本取中位数；配对变化只计算同题同轮两组都成功的样本。\n- 原流程是“Kimi/Claude Agent SDK 执行 + Jev 辅助”，不是纯 Kimi，也不是 Codex。新流程同时改变页面读取、模型调用与辅助方式，因此不是 Jev 模型本身的独立消融实验。\n- 每个运行前验证执行代码哈希未变。源文件和原题哈希见 [manifest.json](manifest.json)。测试站只增加私有 IPC 重置与请求日志，不改页面和业务响应。\n- SDK 金额不包含 Jev、直接文本辅助，不可作为总费用比较。缓存和线上模型延迟仍可能波动；本地三轮样本不能代表所有网站。\n\n## 汇总\n\n| 任务 | Jev 成功 | 成功中位数/秒 | 原流程成功 | 成功中位数/秒 | Jev 启动完整 SDK | 成功配对耗时减少中位数 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${table}\n\n正数表示 Jev 优先更快，负数表示更慢。失败率必须和耗时一起看；成功样本数不同的两列中位数不能单独当作公平配对结论。\n\n\`\`\`json\n${JSON.stringify(totals,null,2)}\n\`\`\`\n\n## 全部运行\n\n| 任务 | 轮次 | 模式 | 结果 / 状态 | 秒 | Jev 直接动作 | 文本辅助 | 完整 SDK | 分类 | 证据 |\n| --- | ---: | --- | --- | ---: | ---: | ---: | --- | --- | --- |\n${trialTable}\n\n## 复现\n\n在 ProfilePilot 仓库运行：\n\n\`\`\`powershell\nnode scripts/bench-jev-garden.mjs <明确分配的独立Profile-ID> <逻辑端口> 3\nnode scripts/summarize-jev-benchmark.mjs <本次结果目录>\n\`\`\`\n\n测试账号和文件均为原靶场虚构数据。不要使用正在由用户或其他会话控制的 Profile。\n`;
// Preserve the original strict grades and add the source task's independent
// correctness criterion. A correct answer with a partial product status is not
// a data error, but is also not successful product completion.
const objective = r => r.page && r.answer;
const ranges = rs => ({ medianMs: median(rs.map(r=>r.elapsedMs)), minMs: rs.length ? Math.min(...rs.map(r=>r.elapsedMs)) : null, maxMs: rs.length ? Math.max(...rs.map(r=>r.elapsedMs)) : null });
const objectiveRows = summary.manifest.tasks.map(t => {
  const all = cells.filter(r=>r.taskId===t.id), d=all.filter(r=>r.mode==='driver'), a=all.filter(r=>r.mode==='advisory');
  const summarize = rs => ({ count:rs.length, passed:rs.filter(objective).length, strictPassed:rs.filter(r=>r.grade==='pass').length, fallback:rs.filter(r=>r.fallback).length, ...ranges(rs.filter(objective)), strictRange:ranges(rs.filter(r=>r.grade==='pass')) });
  const paired=d.flatMap(r=>{const other=a.find(x=>x.round===r.round);return objective(r)&&other&&objective(other)?[{round:r.round,driverMs:r.elapsedMs,advisoryMs:other.elapsedMs,reductionPct:(1-r.elapsedMs/other.elapsedMs)*100}]:[];});
  return {id:t.id,name:t.name,driver:summarize(d),advisory:summarize(a),paired,pairMedianReductionPct:median(paired.map(p=>p.reductionPct))};
});
for(const mode of ['driver','advisory']) {
  const rs=cells.filter(r=>r.mode===mode);
  totals[mode].objectivePassed=rs.filter(objective).length;
  totals[mode].correctButIncomplete=rs.filter(r=>objective(r)&&r.grade!=='pass').length;
  totals[mode].runtimeFailures=rs.filter(r=>r.processFailure).length;
  totals[mode].incompleteTelemetry=rs.filter(r=>r.telemetryIncomplete).length;
}
const timeRange = s => s.medianMs==null?'—':`${seconds(s.medianMs)}（${seconds(s.minMs)}–${seconds(s.maxMs)}）`;
const objectiveTable=objectiveRows.map(r=>`| ${r.id} ${r.name} | ${r.driver.passed}/${r.driver.count}；${r.driver.strictPassed}/${r.driver.count} | ${timeRange(r.driver)} | ${r.advisory.passed}/${r.advisory.count}；${r.advisory.strictPassed}/${r.advisory.count} | ${timeRange(r.advisory)} | ${r.driver.fallback}/${r.driver.count} | ${r.pairMedianReductionPct==null?'—':r.pairMedianReductionPct.toFixed(1)+'%'}（${r.paired.length} 对） |`).join('\n');
const supplementary=`## 原题正确性与产品完成分开统计

**原题验收**要求答案正确且独立页面状态与请求日志证明确实操作；**产品完成**在此基础上还要求状态为 completed。后者比原文题目多一层交付要求。答案正确但 finish_task 证据格式校验失败而返回 partial，记作原题通过、产品未正常完成。原始 grade 保留不改。

表中“原题；产品”分开计数。时间是原题通过样本的中位数（最小–最大），单位秒；配对仅取同题同轮两组均通过原题验收的样本。回退 SDK 的运行仍计入 Jev 组，不按实际执行路径事后挑选样本。

| 任务 | Jev 原题；产品 | Jev 中位数（范围） | 原流程 原题；产品 | 原流程中位数（范围） | Jev 启动 SDK | 配对耗时减少中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${objectiveTable}

### 测试准备与边界

- 独立的准备会话先打开相同首页并结束，然后才启动正式任务会话和计时。浏览器已启动，因此不测应用冷启动。
- 预试验 jev-core-2026-09-20T11-31-48-371Z（6 条）和旧正式批次 jev-core-2026-09-20T11-42-02-059Z（8 条）均因 CDP 会话归属拒绝中断，整批保留，均不混入本次结果。前一批调整了测试准备方式；后一批定位到页面控制条错误采用并释放了 Agent 的 CDP Session。
- 修复页面控制条的 Session 归属后，通过 78 项回归检查及真实浏览器 12 次循环验证，再单独重启桌面应用加载修复。Gateway 和四个 Chrome 进程保留。本批次从头运行 36 次，期间冻结产品执行代码；详见旧正式批次中的 GATEWAY-DIAGNOSIS.md。
- 本批第 32 条 T06-driver-r3 遇到四分钟定时器对 partial 任务执行 pause 的未处理异常，进程退出。保留该条失败，不重跑替换；原文件商品数值正确，但 columns/rows 格式不满足题目要求的对象数组。240 秒为时限截尾标记，不是精确完成耗时；独立验收、请求日志和最终 SDK 用量缺失。随后核验同一产品哈希、模型、Gateway 和 Profile，仅继续余下四条。详见 RUNTIME-INTERRUPTION.md；manifest.continuations 记录恢复时间。因此这是有一次运行中断并恢复的 36 次尝试，不是连续无故障的 36 次运行。
- 正式批次首次出现会话归属拒绝即停止，不重试绕过。每次正式运行前核验产品代码哈希。
- 未纳入 Network mock、性能追踪、扩展安装等开发者工具任务，因为超出当前产品的页面操作工具范围。也不与旧文章六种工具的历史数字直接排名。
- 每题每组只有三次，本地受控任务不代表淘宝、BOSS 或内网页面的普遍效果。线上延迟和缓存会波动，不能据此断言统计显著性。

`;
const statusNote=runStatus ? `**批次状态：${runStatus.status}。${runStatus.reason}**\n\n` : '';
await writeFile(path.join(root,'REPORT.md'),report.replace('## 条件与口径',statusNote+supplementary+'## 条件与口径'));
await writeFile(path.join(root,'analysis.json'),JSON.stringify({totals,rows,objectiveRows,cells:cells.map(r=>({id:r.taskId,mode:r.mode,round:r.round,objectivePassed:objective(r),grade:r.grade,diagnosis:diagnosis(r),elapsedMs:r.elapsedMs}))},null,2));
const escape = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const htmlRows=objectiveRows.map(r=>`<tr><td>${escape(r.id+' '+r.name)}</td><td>${r.driver.passed}/${r.driver.count} · ${r.driver.strictPassed}/${r.driver.count}</td><td>${timeRange(r.driver)}</td><td>${r.advisory.passed}/${r.advisory.count} · ${r.advisory.strictPassed}/${r.advisory.count}</td><td>${timeRange(r.advisory)}</td><td>${r.driver.fallback}/${r.driver.count}</td><td>${r.pairMedianReductionPct==null?'—':r.pairMedianReductionPct.toFixed(1)+'%'} / ${r.paired.length} 对</td></tr>`).join('');
const trials=cells.map(r=>`<tr><td>${r.taskId} / ${r.round}</td><td>${r.mode}</td><td>${objective(r)?'通过':'未通过'}</td><td>${r.grade} / ${r.status}</td><td>${r.elapsedCensored ? "≥240（中断）" : seconds(r.elapsedMs)}</td><td>${r.usage.jevActions||0}</td><td>${r.fallback?'是':'否'}</td><td><a href="${escape(r.file)}">证据</a></td></tr>`).join('');
await writeFile(path.join(root,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev × Garden Lab 实测</title><style>body{font:16px/1.7 system-ui;background:#f5f5f0;color:#182622;max-width:1240px;margin:48px auto;padding:0 24px}table{width:100%;border-collapse:collapse;background:white;margin:24px 0}th,td{padding:12px;border-bottom:1px solid #ddd;text-align:left}th{background:#e3ebe4}h1{font-size:32px}a{color:#176749}.scroll{overflow:auto}.status{padding:16px;border-left:4px solid #ad6819;background:#fff1d9}small{color:#52625b}</style><h1>Jev × Garden Lab</h1><p>原任务卡、原页面 · ${escape(summary.manifest.model)} · 两种完整产品执行方式</p><p class="status">${runStatus?escape(runStatus.status+'：'+runStatus.reason):cells.length===summary.planned?'完整批次已结束':'临时结果，评测尚未完成'} · 已记录 ${cells.length}/${summary.planned} 次</p><p>原题验收通过：Jev ${totals.driver.objectivePassed}/${totals.driver.runs}，原流程 ${totals.advisory.objectivePassed}/${totals.advisory.runs}。产品正常完成：Jev ${totals.driver.passed}/${totals.driver.runs}，原流程 ${totals.advisory.passed}/${totals.advisory.runs}。</p><p>“原题”验证正确答案与实际页面操作；“产品”额外要求 completed 状态。时间为原题通过样本的中位数（范围），单位秒。减少比例只比较同题同轮两组都通过的样本，失败不算提速。</p><div class="scroll"><table><tr><th>任务</th><th>Jev 原题 · 产品</th><th>Jev 中位数（范围）</th><th>原流程 原题 · 产品</th><th>原流程中位数（范围）</th><th>Jev 启动 SDK</th><th>配对减少 / 数量</th></tr>${htmlRows}</table></div><p>原流程为 Kimi / Claude Agent SDK + Jev 辅助；不是纯 Kimi 或 Codex。Jev 优先模式包含不同的观察链路、文本辅助和回退策略，不能把所有差异归因于 Jev 模型。受控靶场、少量样本不能代表真实网站整体性能。</p><p><a href="REPORT.md">完整报告</a> · <a href="analysis.json">双口径统计</a> · <a href="manifest.json">原题与条件</a> · <a href="summary.json">原始汇总</a></p><h2>全部记录</h2><div class="scroll"><table><tr><th>任务 / 轮次</th><th>模式</th><th>原题</th><th>原始结果 / 状态</th><th>秒</th><th>Jev 操作</th><th>启动 SDK</th><th>明细</th></tr>${trials}</table></div><small>${escape(summary.manifest.runId)}</small></html>`);
console.log(JSON.stringify({completed:cells.length,totals,objectiveRows},null,2));
