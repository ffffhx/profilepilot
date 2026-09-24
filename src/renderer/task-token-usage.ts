import type { TaskSnapshot } from "../shared/tasks";
import { costTotals } from "../shared/task-cost";
import { tokenTotals, updateTokenRecords, modelTokenTotals, type TokenSource } from "../shared/task-token-usage";

const escape = (text: string): string => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const n = (value: number): string => value.toLocaleString("zh-CN");
const sources = [["all", "全部调用"], ["model", "主模型"], ["jev", "Jev"], ["helper", "文本辅助"]] as const;
const money = (min: number, max: number, currency: string): string => `${currency === "CNY" ? "¥" : "$"}${min.toFixed(6)}${Math.abs(max - min) > 1e-10 ? `–${max.toFixed(6)}` : ""}`;
const costLabel = (totals: ReturnType<typeof costTotals>): string => totals.amounts.map(a => money(a.min, a.max, a.currency)).join(" + ") || "—";

export function tokenUsagePage(data: TaskSnapshot, source: TokenSource): string {
  const records = updateTokenRecords(data.tokenRecords || [], data.tasks);
  const totals = tokenTotals(records, source);
  const models = modelTokenTotals(records);
  const costs = costTotals(records, source);
  const charges = records.flatMap(r => r.costRecords || []).filter(c => source === "all" || source === c.source).sort((a, b) => b.at.localeCompare(a.at));
  const sdkCost = records.reduce((sum, r) => sum + (r.sdkCostUsd || 0), 0);
  const rows = records.filter(r => tokenTotals([r], source).total > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const max = Math.max(1, ...sources.slice(1).map(([key]) => tokenTotals(records, key).total));
  return `<section class="token-usage" aria-label="Token 消耗统计">
    <div class="usage-intro"><h2>用量概览</h2><p class="muted">本机累计用量 · 自动保存，重启后继续累计</p></div>
    <div class="usage-tabs" role="group" aria-label="调用来源">${sources.map(([key, label]) => `<button type="button" data-usage-source="${key}" aria-pressed="${source === key}" class="${source === key ? "active" : ""}">${label}</button>`).join("")}</div>
    <div class="usage-metrics">${[["已记录 Token", totals.total], ["输入 · 含缓存", totals.input], ["输出", totals.output]].map(([label, value]) => `<div><small>${label}</small><strong>${source === "jev" && label === "输出" ? "—" : n(Number(value))}</strong></div>`).join("")}</div>
    <section class="panel usage-costs"><div class="panel-header"><h2>已记录费用 · 估算</h2><small>${costs.calls} 次调用已计价</small></div><strong class="usage-cost-total">${costLabel(costs)}</strong><p class="usage-note">仅含已取得缓存明细和计价依据的调用，不代表全部花费。人民币与美元分开累计。— 表示未计价，不是免费。</p><p class="usage-note">价格核对：2026-09-24，有效至 2026-10-24。DeepSeek 按 UTC 峰谷时段、周末和中国节假日估算；调用跨时段时显示范围。Kimi 按缓存命中和写入 TTL 估算。金额在记录时保存，不用新价格重算旧调用。</p>${(source === "all" || source === "model") && sdkCost > 0 ? `<details><summary>旧版 SDK 参考金额：$${sdkCost.toFixed(6)}</summary><p class="usage-note">SDK 按自身价格表估算，兼容服务可能套用默认模型价格，无法可靠反映峰谷折扣。此金额未加入上方估算合计，也不是官方账单。</p></details>` : ""}</section>
    ${source === "all" || source === "model" ? `<section class="panel usage-records usage-models"><div class="panel-header"><h2>主模型明细</h2><small>按实际返回的模型名称统计</small></div>${models.length ? `<div class="usage-table-scroll"><table><thead><tr><th>模型</th><th>输入 · 含缓存</th><th>输出</th><th>合计</th><th>已计价部分 · 估算</th></tr></thead><tbody>${models.map(m => `<tr><td><strong>${escape(m.model)}</strong>${m.historical ? '<small>历史用量 · 仅保留任务模型记录，未保存逐模型计数</small>' : ''}</td><td>${n(m.inputTokens)}</td><td>${n(m.outputTokens)}</td><td>${n(m.inputTokens + m.outputTokens)}</td><td>${m.historical ? "—" : costLabel(costTotals(records, "model", m.model))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">模型返回用量后，会在这里显示具体模型及消耗。</p>'}${models.some(m => m.historical) ? '<p class="usage-note">历史记录中的模型名称来自任务执行记录；同一任务用过多个模型的历史用量合并显示，无法准确拆分。新返回的逐模型计数会自动替换对应的历史汇总。</p>' : ''}</section>` : ''}
    <section class="panel usage-breakdown"><h2>调用来源</h2>${sources.slice(1).map(([key, label]) => { const value = tokenTotals(records, key).total; return `<div class="usage-source-row"><span>${label}</span><progress class="usage-bar" value="${value}" max="${max}" aria-label="${label} Token">${n(value)}</progress><span>${n(value)}</span></div>`; }).join("")}</section>
    <section class="panel usage-records"><div class="panel-header"><h2>任务明细</h2><small>${rows.length} 条用量记录</small></div>${rows.length ? `<div class="usage-table-scroll"><table><thead><tr><th>任务</th><th>输入</th><th>输出</th><th>合计</th></tr></thead><tbody>${rows.map(r => { const task = data.tasks.find(t => t.id === r.taskId), t = tokenTotals([r], source); return `<tr><td>${task ? `<button class="usage-task-link" data-task="${escape(task.id)}">${escape(task.title)}</button>` : '<span class="muted">已删除的任务</span>'}<small>${escape(new Date(r.updatedAt).toLocaleString("zh-CN"))}${task?.modelRuns?.length ? ` · ${escape([...new Set(task.modelRuns.map(m => m.id))].join(" / "))}` : ""}</small></td><td>${n(t.input)}</td><td>${source === "jev" ? "—" : n(t.output)}</td><td>${n(t.total)}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="usage-empty"><h3>还没有已返回的用量</h3><p class="muted">开始任务后，模型返回的 Token 用量会自动出现在这里。</p><button data-nav="tasks">新建任务 →</button></div>'}</section>
    <p class="usage-note">统计服务实际返回的 Token，不按文字长度估算。主模型通常在一轮执行结束后更新；Jev 当前仅记录输入，输出未提供。中断或未返回用量的调用可能未计入。</p>
    ${charges.length ? `<section class="panel usage-records usage-cost-detail"><div class="panel-header"><h2>调用费用记录</h2><small>最近 ${Math.min(charges.length, 30)} 条 / 共 ${charges.length} 条</small></div><div class="usage-table-scroll"><table><thead><tr><th>模型 / 计价依据</th><th>时间</th><th>估算费用</th></tr></thead><tbody>${charges.slice(0, 30).map(c => `<tr><td>${escape(c.model)} · ${c.source === "model" ? "主模型" : "文本辅助"}<small>${escape(c.estimate?.basis || "未计价：不支持的模型或服务、缺少计费数据，或价格表已过期")}</small></td><td>${escape(new Date(c.at).toLocaleString("zh-CN"))}</td><td>${c.estimate ? money(c.estimate.min, c.estimate.max, c.estimate.currency) : "—"}</td></tr>`).join("")}</tbody></table></div></section>` : ''}
    <p class="usage-note">已保存的历史任务已纳入统计；此前已删除的任务无法补回。删除任务后保留匿名用量，不保留任务内容。此处为 Token 记录，实际计费以服务商账单为准。</p>
  </section>`;
}
