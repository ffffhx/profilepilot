// Recover an attempted cell from its durable task journal; never rerun it or
// reconstruct missing timing / independent validation as if it was observed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const runId = 'jev-core-2026-09-20T12-39-30-184Z';
const cell = 'T06-driver-r3';
const root = path.resolve('../garden-lab/apps/browser-tool-bench/results', runId);
const summary = JSON.parse(await readFile(path.join(root, 'summary.json'), 'utf8'));
assert.equal(summary.results.length, 31);
const task = JSON.parse(await readFile(path.join('.cpm-data', runId, cell, 'tasks.json'), 'utf8')).tasks[0];
assert.equal(task.sessionId, 'pp-task-c8e637ed-9e9f-47a5-b0e8-3cc2158045d7');
assert.equal(task.status, 'partial');
const output = task.outputs.find(f => f.name === 'catalog_products.json');
const exported = await readFile(output.path, 'utf8');
const products = JSON.parse(exported);
const truth = [['雷霆工作站',15999,2],['全画幅扫描仪',3699,3],['4K 专业显示器',2499,7],['人体工学椅',1899,0],['会议级摄像头',1599,11],['桌面监听音箱',1299,5],['降噪耳机 Pro',899,41],['便携 SSD 1TB',749,16],['USB-C 扩展坞',549,64],['电竞鼠标',459,0],['静音机械键盘',399,23],['智能护眼台灯',329,88]];
assert.deepEqual(products.columns, ['name','price','stock']);
assert.deepEqual(products.rows, truth);
const failure = {
  kind: 'unhandled_terminal_task_timer_rejection',
  error: 'Error: 任务已经结束，可选择再次执行。 at TaskService.control; at Timeout._onTimeout',
  recoveredAt: new Date().toISOString(),
  note: 'At the 4-minute task timer, control(pause) rejected because status was already partial. The process exited with code 1 before persisting this cell. No retry or rescue. Exported product values are correct, but columns/rows format does not satisfy the requested object array. Request journal, independent validation, final SDK usage and exact elapsed duration were lost. Not counted as verified success or included in successful timing statistics.'
};
const row = {
  taskId:'T06',name:'分页商品 JSON',mode:'driver',round:3,grade:'fail',status:task.status,
  page:false,answer:false,elapsedMs:240000,elapsedCensored:true,validationMs:0,
  usage:task.usage,usageComplete:false,fallback:true,result:task.result,
  answerText:[task.result.summary,exported].join('\n'),
  validation:{error:'Independent validation and fixture request journal were not persisted before process exit.'},
  requests:[],decisions:[],observations:task.observation?[task.observation]:[],toolCalls:[],
  receipts:task.receipts,events:task.events,file:cell+'.json',processFailure:failure,
  telemetryIncomplete:true,recoveredProductValuesCorrect:true
};
await writeFile(path.join(root,row.file),JSON.stringify(row,null,2));
await writeFile(path.join(root,'T06-driver-r3-export.json'),exported);
await writeFile(path.join(root,'RUNTIME-INTERRUPTION.md'),`# 第 32 次运行中断\n\n${failure.error}\n\n任务生成了商品文件，但返回 partial；四分钟定时器随后仍调用 pause，未处理的拒绝终止了评测进程。页面会话连接保持正常，不是 CDP 归属错误。\n\n保留这一条为未正常完成，不重跑、不替换；240 秒是达到时限的截尾标记，并非精确完成耗时，不进入成功速度统计。12 项商品的名称、价格、库存和排序正确，但导出的是 columns/rows 对象，没有交付要求的 name/price/stock 对象数组，答案格式不通过。独立 DOM 验收、服务端请求日志及最终 SDK 用量未持久化，不能补造完整验收数据。\n\n仅结束这一条遗留测试会话，产品代码、模型、Gateway、Chrome 与测试题不变，继续剩余四条未尝试的运行。恢复运行时将核对原始 manifest 哈希。\n`);
summary.results.push({...row,observations:undefined,toolCalls:undefined,receipts:undefined,events:undefined,answerText:undefined,requests:undefined,decisions:undefined});
summary.completed=summary.results.length;
await writeFile(path.join(root,'summary.json'),JSON.stringify(summary,null,2));
const { requestBrowserGateway } = require('../dist/main/browser-gateway-client');
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const state=await requestBrowserGateway({action:'status'});
const binding=state.state.profiles.find(p=>p.publicPort===9227);
assert.equal(binding.ownerSessionId, task.sessionId, 'Test ownership changed; do not release another session.');
await new WrapperBrowser('.cpm-data/recovery-artifacts').control(task,'release');
console.log(JSON.stringify({preserved:summary.completed,interruptedCell:cell,productValuesCorrect:true,answerFormatCorrect:false,oldTestSessionReleased:true}));
