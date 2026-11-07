import { AsyncLocalStorage } from "node:async_hooks";
import type { ControlTraceEvent } from "./control-trace";
import { parseControlRecovery } from "../shared/control-recovery";

export const controlTraceContext = new AsyncLocalStorage<Partial<ControlTraceEvent>>();
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Capture only protocol metadata. Never retain action text, URLs, selectors,
 * credentials, stdout, image data or arbitrary error messages in the context. */
export function noteControlTraceCommand(value: unknown): void {
  const context = controlTraceContext.getStore();
  if (!context) return;
  const command = object(value), params = object(command.params), action = object(params.action);
  const session = params.sessionId ?? command.session;
  const target = params.id ?? command.windowId ?? command.target ?? command.appId;
  if (typeof session === "string") context.sessionId = session;
  if (typeof target === "string") context.target = target;
  if (typeof params.generation === "number") context.generation = params.generation;
  const kind = action.kind ?? params.kind ?? command.tool;
  if (typeof kind === "string") context.actionKind = kind;
  const request = params.requestId ?? command.requestId;
  if (typeof request === "string") context.actionRequestId = request;
}

export function noteControlTraceResponse(value: unknown): void {
  const context = controlTraceContext.getStore();
  if (!context) return;
  const response = object(value), error = object(response.error), details = object(error.details ?? response.details);
  const recovery = parseControlRecovery(response.recovery ?? error.recovery ?? details.recovery);
  if (response.ok === true) { delete context.code; delete context.recovery; }
  if (recovery) context.recovery = recovery;
  const code = response.code ?? error.code;
  if (typeof code === "string") context.code = code;
  const requestId = response.requestId ?? response.id;
  if (typeof requestId === "string") context.requestId = requestId;
  const data = object(response.data ?? response.result), state = object(data.state ?? data.session);
  const sessionId = state.sessionId ?? state.name;
  if (typeof sessionId === "string") context.sessionId = sessionId;
}
