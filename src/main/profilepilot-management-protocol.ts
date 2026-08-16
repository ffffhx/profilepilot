import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION = 1;
export const PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES = 1024 * 1024;

export type ProfilePilotManagementCommand =
  | { action: "ping" }
  | { action: "profile.list" }
  | { action: "profile.get"; selector: string }
  | { action: "profile.create"; name: string }
  | { action: "profile.rename"; selector: string; name: string }
  | { action: "profile.start"; selector: string }
  | { action: "profile.stop"; selector: string }
  | { action: "profile.delete"; selector: string; confirmed: boolean };

export interface ProfilePilotManagementRequest {
  version: 1;
  id: string;
  token: string;
  command: ProfilePilotManagementCommand;
}

export type ProfilePilotManagementResponse =
  | {
      version: 1;
      id: string;
      ok: true;
      data: unknown;
    }
  | {
      version: 1;
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };

export function profilePilotManagementRoot(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = String(env.PROFILEPILOT_MANAGEMENT_ROOT || "").trim();
  return override ? path.resolve(override) : path.join(homeDir, ".profilepilot", "management");
}

export function profilePilotManagementSocketPath(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const root = profilePilotManagementRoot(homeDir, env);
  if (process.platform === "win32") {
    const suffix = createHash("sha256").update(root).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\profilepilot-management-${suffix}`;
  }
  return path.join(root, "control.sock");
}

export function profilePilotManagementSecretPath(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(profilePilotManagementRoot(homeDir, env), "secret");
}
