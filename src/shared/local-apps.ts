export const LOCAL_APPS_CHANNEL = "local-apps:request";

export interface LocalAppInput {
  id?: string;
  name: string;
  mode: "launch" | "attach" | "service";
  cwd: string;
  command: string;
  environment: string;
  cdpPort: number | null;
  inspectPort: number | null;
  agentPort?: number | null;
  servicePort?: number | null;
  serviceProcess?: string;
  logPath?: string;
}

export interface LocalAppConfig extends LocalAppInput {
  id: string;
  createdAt: string;
}

export interface LocalAppRuntime {
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  error: string;
}

export interface LocalDebugTarget {
  id: string;
  title: string;
  url: string;
  kind: "renderer" | "main";
}

export interface LocalAppView extends LocalAppConfig {
  runtime: LocalAppRuntime;
  debug: { renderer: boolean; main: boolean; targets: LocalDebugTarget[] };
  agent?: LocalAppAgentState;
}

export interface LocalAppAgentState {
  connected: boolean;
  sessionId?: string;
  ownership?: "agent" | "user";
  error?: string;
}

export interface LocalAppsApi {
  list(): Promise<LocalAppView[]>;
  save(input: LocalAppInput): Promise<string>;
  remove(id: string): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  logs(id: string): Promise<string>;
  pickDirectory(): Promise<string | null>;
  openDirectory(id: string): Promise<void>;
  openDebugger(id: string, kind: "renderer" | "main", targetId: string): Promise<void>;
  agentControl(id: string, command: "takeover" | "return" | "stop"): Promise<void>;
}
