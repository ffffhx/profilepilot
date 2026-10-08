import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { BrowserTask, CreateTaskInput, TaskEvent, TaskStream, TaskSettings, TaskPermissionMode, TaskMessageOptions } from "../shared/tasks";
import type { PhoneManagementCommand } from "./phones/management";

export const PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION = 1;
export const PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES = 1024 * 1024;
export const PROFILEPILOT_PHONE_MAX_RESPONSE_BYTES = 9 * 1024 * 1024;

export type ProfilePilotTaskCommand =
  | { action: "task.create"; profile: string; input: Omit<CreateTaskInput, "profileId"> }
  | { action: "task.list"; limit?: number; offset?: number }
  | { action: "task.get"; id: string; after?: number; limit?: number; revision?: number }
  | ({ action: "task.control"; id: string; control: "pause" | "resume" | "takeover" | "cancel" | "steer" | "queue"; message?: string } & TaskMessageOptions)
  | ({ action: "task.reply"; id: string; decisionId: string; answer: string; approved?: boolean; scope?: "once" | "session" } & TaskMessageOptions)
  | { action: "task.queue"; id: string; removeId?: string }
  | { action: "task.limits"; id: string; limits: Partial<BrowserTask["limits"]> }
  | { action: "task.settings.get" }
  | { action: "task.settings.update"; input: Partial<TaskSettings> & { apiKey?: string } }
  | { action: "task.models" }
  | { action: "task.connection.test" }
  | { action: "task.attachments.import"; paths: string[]; id?: string }
  | { action: "task.metadata"; id: string; title: string }
  | { action: "task.fork"; id: string; title?: string; eventId?: string }
  | { action: "task.rewind"; id: string; eventId: string }
  | { action: "task.compact"; id: string; instructions?: string }
  | { action: "task.mode"; id: string; mode: TaskPermissionMode; model?: string }
  | { action: "task.model"; id: string; model: string }
  | { action: "task.permissions"; id: string; revokeId?: string }
  | { action: "task.status"; id: string };

export type ManagementTask = Pick<BrowserTask,
  "id" | "title" | "prompt" | "profileId" | "profileName" | "status" | "createdAt" | "updatedAt" |
  "pending" | "result" | "plan" | "items" | "usage" | "limits" | "outputs" | "needsReconciliation" | "mode" | "model" | "messageQueue" | "historyRevision"
> & { running: boolean; truncated?: string[]; checkpoints?: Array<{ eventId: string; at: string; prompt: string }> };

export type ManagementTaskSummary = Pick<ManagementTask,
  "id" | "title" | "profileId" | "profileName" | "status" | "createdAt" | "updatedAt" |
  "usage" | "limits" | "needsReconciliation" | "running"
>;

export interface ManagementTaskPage { task: ManagementTask; events: TaskEvent[]; cursor: number; hasMore: boolean; stream?: TaskStream; revision?: number; reset?: boolean; }

export type ProfilePilotManagementCommand = ProfilePilotTaskCommand | PhoneManagementCommand
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
