import type { ScheduleRepeat } from "./tasks";

function parts(at: number, timezone: string): Record<string, number> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}
function wallClock(at: number, timezone: string): number { const p = parts(at, timezone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }
export function zonedLocalToIso(input: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(input)) throw new Error("执行时间格式不正确。");
  const local = Date.parse(input.length === 16 ? `${input}:00Z` : `${input}Z`);
  const candidates = new Set<number>();
  for (const delta of [-86400000, -43200000, 0, 43200000, 86400000]) {
    const probe = local + delta;
    const candidate = local - (wallClock(probe, timezone) - probe);
    if (wallClock(candidate, timezone) === local) candidates.add(candidate);
  }
  if (!candidates.size) throw new Error("该时区不存在这个本地时间（可能处于夏令时跳转），请选择其他时间。");
  return new Date(Math.min(...candidates)).toISOString();
}

export function nextDailyOccurrence(previous: string, timezone: string, after = Date.now()): string {
  return nextScheduleOccurrence(previous, timezone, "daily", after);
}

export function nextScheduleOccurrence(previous: string, timezone: string, repeat: ScheduleRepeat, after = Date.now()): string {
  const p = parts(Date.parse(previous), timezone);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  const targetWeekday = new Date(day).getUTCDay();
  const timeSuffix = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const stepDays = repeat === "weekly" ? 7 : 1;
  for (let i = 0; i < 4000; i++) {
    day += stepDays * 86400000;
    const weekday = new Date(day).getUTCDay();
    if (repeat === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (repeat === "weekly" && weekday !== targetWeekday) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    try {
      const next = zonedLocalToIso(`${date}T${timeSuffix}`, timezone);
      if (Date.parse(next) > after) return next;
    } catch { /* Skip nonexistent local time during DST spring-forward. */ }
  }
  throw new Error("无法计算下次执行时间。");
}

/** Advance a paused schedule whose timestamp is in the past to the next upcoming wall-clock occurrence. */
export function nextUpcomingOccurrence(previous: string, timezone: string, repeat: ScheduleRepeat, after = Date.now()): string {
  const prevParts = parts(Date.parse(previous), timezone);
  const nowParts = parts(after, timezone);
  const targetWeekday = new Date(Date.UTC(prevParts.year, prevParts.month - 1, prevParts.day)).getUTCDay();
  const timeSuffix = `${String(prevParts.hour).padStart(2, "0")}:${String(prevParts.minute).padStart(2, "0")}`;
  let day = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  for (let i = 0; i < 4000; i++) {
    const currentDay = day + i * 86400000;
    const weekday = new Date(currentDay).getUTCDay();
    if (repeat === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (repeat === "weekly" && weekday !== targetWeekday) continue;
    const date = new Date(currentDay).toISOString().slice(0, 10);
    try {
      const next = zonedLocalToIso(`${date}T${timeSuffix}`, timezone);
      if (Date.parse(next) > after) return next;
    } catch { /* Skip nonexistent local time during DST spring-forward. */ }
  }
  throw new Error("无法计算下次执行时间。");
}
