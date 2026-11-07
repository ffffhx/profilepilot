import { z } from "zod";

export const xianyuCriteria = z.object({
  include: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  exclude: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  excludeRepaired: z.boolean().default(false),
  memory: z.object({ generation: z.enum(["DDR3", "DDR4", "DDR5"]).optional(), totalGB: z.number().int().positive().max(4096).optional(),
    pieces: z.number().int().min(1).max(16).optional(), formFactor: z.enum(["desktop", "laptop"]).optional() }).strict().optional()
}).strict();
export const xianyuSearchSchema = z.object({
  query: z.string().trim().min(1).max(200), page: z.number().int().min(1).max(50).default(1),
  limit: z.number().int().min(1).max(30).default(20), itemOffset: z.number().int().min(0).max(29).default(0),
  sort: z.enum(["general", "latest", "price_asc", "price_desc", "price_drop"]).default("general"),
  minPrice: z.number().finite().min(0).max(100000000).optional(), maxPrice: z.number().finite().min(0).max(100000000).optional(),
  personalOnly: z.boolean().default(false), freeShipping: z.boolean().default(false), newOnly: z.boolean().default(false),
  region: z.object({ province: z.string().trim().min(1).max(30), city: z.string().trim().min(1).max(30).optional(), area: z.string().trim().min(1).max(30).optional() }).strict().optional(),
  criteria: xianyuCriteria.optional(), refresh: z.boolean().default(false)
}).strict();
export const xianyuDetailSchema = z.object({ id: z.string().regex(/^\d{1,30}$/), criteria: xianyuCriteria.optional(), refresh: z.boolean().default(false) }).strict();
export const xianyuRegionsSchema = z.object({ parentId: z.string().regex(/^-?\d{1,20}$/).optional(), refresh: z.boolean().default(false) }).strict();
export type XianyuCriteria = z.infer<typeof xianyuCriteria>;
