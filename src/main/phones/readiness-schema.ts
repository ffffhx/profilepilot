import { z } from "zod";
import { PHONE_DEBUG_REASONS } from "../../shared/phones";
import { wirelessAddress } from "./wireless";

const debug = z.enum(["enabled", "disabled", "unconfirmed"]);
const reason = z.enum(PHONE_DEBUG_REASONS).optional();
/** Optional diagnostics retain compatibility with companions released before 0.2.1. */
export const readinessSchema = z.object({
  unlocked: z.boolean(), computerConnected: z.boolean(), usbConnected: z.boolean(), wifiConnected: z.boolean(),
  developerOptions: debug, usbDebugging: debug, wirelessDebugging: debug,
  accessibilityService: z.enum(["running", "enabled", "disabled", "unknown"]),
  debugReasons: z.object({ developerOptions: reason, usbDebugging: reason, wirelessDebugging: reason }).optional(),
  appVersion: z.string().min(1).max(40).regex(/^[\w.+-]+$/).optional(),
  network: z.object({
    wifiIpv4: z.array(z.string().refine(value => { try { return wirelessAddress(value + ":1") === value + ":1"; } catch { return false; } })).max(8),
    adbEndpoints: z.array(z.object({ address: z.string().refine(value => { try { wirelessAddress(value); return true; } catch { return false; } }), ageMs: z.number().int().min(0).max(60000) })).max(8)
  }).refine(value => value.adbEndpoints.every(endpoint => value.wifiIpv4.includes(endpoint.address.split(":")[0]))).optional()
});
