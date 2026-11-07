import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const SUITE = 'profilepilot-agent-tasks';
export const STATUSES = ['success', 'failed', 'blocked', 'timeout', 'environment_invalid', 'not_run'];

export function makePlan(catalog, { tasks, seeds, condition = 'baseline', repeat = 1, group = 'synthetic' } = {}) {
  if (!['synthetic', 'live-site', 'recovery'].includes(group)) throw Error('Group must be synthetic|live-site|recovery');
  const selected = tasks?.length ? tasks.map(id => {
    const task = catalog.tasks.find(task => task.id === id);
    if (!task) throw Error(`Unknown task: ${id}`);
    if (task.status !== 'ready') throw Error(`Task ${id} is planned, not executable`);
    if ((task.group || 'synthetic') !== group) throw Error(`Task ${id} belongs to ${task.group || 'synthetic'}; select its --group`);
    return task;
  }) : catalog.tasks.filter(task => task.status === 'ready' && (task.group || 'synthetic') === group);
  if (!selected.length) throw Error('Empty task selection');
  if (new Set(selected.map(task => task.id)).size !== selected.length) throw Error('Duplicate task selection');
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) throw Error('Repeat must be 1..20');
  const plan = [];
  for (const task of selected) {
    if (!task.conditions.includes(condition)) throw Error(`Condition ${condition} is not supported by ${task.id}; select only tasks declaring it`);
    const taskSeeds = seeds || task.seeds || catalog.defaultSeeds;
    if (task.fixedSeeds && taskSeeds.some(seed => !task.seeds.includes(seed))) throw Error(`Task ${task.id} has fixed seeds; use --repeat for repeated trials`);
    if (!taskSeeds.length || taskSeeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) || new Set(taskSeeds).size !== taskSeeds.length) throw Error('Seeds must be unique nonnegative 32-bit integers');
    for (const seed of taskSeeds) for (let repetition = 1; repetition <= repeat; repetition++) {
      plan.push({ id: `${task.id}--${seed}--${condition}--r${repetition}`, taskId: task.id, title: task.title, seed, condition, repetition, group, environment: task.environment });
    }
  }
  return plan;
}

export function summarize(plan, results) {
  const summary = { planned: plan.length, completed: 0, ...Object.fromEntries(STATUSES.map(key => [key, 0])), successRate: 0, totalElapsedMs: 0, totalCostUsd: null };
  const ids = new Set(plan.map(cell => cell.id));
  if (ids.size !== plan.length) throw Error('Duplicate planned cells');
  const seen = new Set(); let knownCost = false;
  for (const result of results) {
    if (!ids.has(result.id) || seen.has(result.id) || !STATUSES.includes(result.status)) throw Error('Results do not match registered plan');
    seen.add(result.id); summary[result.status]++;
    if (result.status !== 'not_run') summary.completed++;
    summary.totalElapsedMs += result.elapsedMs || 0;
    if (Number.isFinite(result.usage?.costUsd)) { knownCost = true; summary.totalCostUsd = (summary.totalCostUsd || 0) + result.usage.costUsd; }
  }
  summary.not_run += plan.length - seen.size;
  summary.successRate = plan.length ? summary.success / plan.length : 0;
  summary.costCoverage = results.filter(result => Number.isFinite(result.usage?.costUsd)).length;
  if (!knownCost) summary.totalCostUsd = null;
  return summary;
}

export function classify({ execution, grade, artifactsError, expectedOutcome = 'completed' }) {
  if (execution?.timedOut) return 'timeout';
  if (execution?.error || artifactsError) return 'failed';
  // A process/finish claim never supplies the task oracle.
  if (execution?.response?.status === 'blocked' && expectedOutcome === 'blocked' && grade.businessGoalAchieved && grade.mandatoryConstraintsMet && grade.checks?.length && grade.checks.every(check => check.passed === true)) return 'success';
  if (execution?.response?.status === 'blocked') return 'blocked';
  if (execution?.response?.status !== 'completed') return 'failed';
  if (grade.businessGoalAchieved && grade.mandatoryConstraintsMet && grade.checks?.length && grade.checks.every(check => check.passed === true)) return 'success';
  return 'failed';
}
