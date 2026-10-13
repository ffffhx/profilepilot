import { uniqueStrings } from "./fs-util";

const MINI_PROFILE_LIMIT = 3;

export function normalizeMiniProfileIds(input: unknown, validProfileIds?: Set<string>): string[] {
  const ids = Array.isArray(input) ? uniqueStrings(input.filter((id): id is string => typeof id === "string")) : [];
  const validIds = validProfileIds ? ids.filter((id) => validProfileIds.has(id)) : ids;
  return validIds.slice(0, MINI_PROFILE_LIMIT);
}

export function normalizeProfileOrder(input: unknown, validProfileIds?: Set<string>): string[] {
  const ids = Array.isArray(input) ? uniqueStrings(input.filter((id): id is string => typeof id === "string")) : [];
  return validProfileIds ? ids.filter((id) => validProfileIds.has(id)) : ids;
}
