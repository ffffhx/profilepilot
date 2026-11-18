import type { ReviewKind, ReviewSettings } from "../../shared/review";

export function localDate(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  return ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-");
}
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
/** Resolve a wall-clock time on either OS; spring-forward gaps move forward,
 * and a repeated hour maps to one stable occurrence (the period key dedupes it). */
export function wallTime(day: string, time: string, timezone: string): number {
  const desired = Date.parse(`${day}T${time}:00Z`);
  let candidate = desired;
  const seen = new Set<number>();
  for (let i = 0; i < 6; i++) {
    if (seen.has(candidate)) return Math.max(...seen);
    seen.add(candidate);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(candidate);
    const get = (name: string) => parts.find(part => part.type === name)!.value;
    const actual = Date.parse(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`);
    if (actual === desired) return candidate;
    candidate += desired - actual;
  }
  return candidate;
}
export function reviewWindow(settings: ReviewSettings, kind: ReviewKind, now: number) {
  let day = localDate(now, settings.timezone);
  if (wallTime(day, settings.time, settings.timezone) > now) day = addDays(day, -1);
  if (kind === "weekly") {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    day = addDays(day, -((weekday - settings.weeklyDay + 7) % 7));
  }
  return { key: `${kind}:${day}`, from: wallTime(addDays(day, kind === "daily" ? -1 : -7), settings.time, settings.timezone), until: wallTime(day, settings.time, settings.timezone) };
}
