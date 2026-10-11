export type AgentZoomCommand = "in" | "out" | "reset";

/** Handle the native accelerator before Electron can zoom the whole window. */
export function agentZoomCommand(input: {
  key: string; code?: string; control: boolean; meta: boolean; alt: boolean; isComposing: boolean;
}, platform: string): AgentZoomCommand | undefined {
  if (input.isComposing || input.alt || !(platform === "darwin" ? input.meta : input.control)) return;
  if (["+", "="].includes(input.key) || input.code === "NumpadAdd") return "in";
  if (["-", "_"].includes(input.key) || input.code === "NumpadSubtract") return "out";
  if (input.key === "0") return "reset";
  return;
}
