import { z } from "zod";

// Exact AND selectors. Ambiguous matches are never resolved by picking the first.
export const phoneSelectorSchema = z.object({
  resourceId: z.string().min(1).max(500).optional(), text: z.string().max(500).optional(),
  description: z.string().min(1).max(500).optional(), className: z.string().min(1).max(500).optional(),
  packageName: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(), checked: z.boolean().optional(),
  editable: z.boolean().optional(), clickable: z.boolean().optional(), scrollable: z.boolean().optional()
}).strict().refine(value => Object.keys(value).length > 0, "定位条件不能为空");
const coordinate = z.number().int().min(0).max(20000);
export const phoneActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), x: coordinate, y: coordinate }).strict(),
  z.object({ kind: z.literal("swipe"), x: coordinate, y: coordinate, toX: coordinate, toY: coordinate, duration: z.number().int().min(50).max(2000).optional() }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("key"), key: z.enum(["back", "home", "recents"]) }).strict(),
  z.object({ kind: z.literal("snapshot") }).strict(), z.object({ kind: z.literal("screenshot"), format: z.literal("png").optional() }).strict(),
  z.object({ kind: z.literal("find"), selector: phoneSelectorSchema }).strict(),
  z.object({ kind: z.literal("click"), selector: phoneSelectorSchema }).strict(),
  z.object({ kind: z.literal("fill"), selector: phoneSelectorSchema, text: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("scroll"), selector: phoneSelectorSchema, direction: z.enum(["forward", "backward"]) }).strict()
]);
export const isPhoneRead = (kind: string): boolean => ["snapshot", "screenshot", "find"].includes(kind);
