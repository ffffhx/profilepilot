export const ENGINE_VERSION = "1.2.0";
export class EngineError extends Error {
  constructor(message: string, readonly code = "BROWSER_ENGINE_ERROR") { super(message); }
}
export interface EngineCommand {
  session: string;
  args: string[];
  json: boolean;
  timeout: number;
  endpoint?: string;
  noAutoDialog?: boolean;
}

/** Prefix parsing stops at the verb: fill/eval payloads are never CLI flags. */
export function parseEngineCommand(input: string[], env = process.env): EngineCommand {
  const command: EngineCommand = { session: env.AGENT_BROWSER_SESSION || "default", args: [], json: false, timeout: 15000 };
  let i = 0;
  for (; i < input.length; i++) {
    const arg = input[i];
    if (arg === "--") { i++; break; }
    if (!arg.startsWith("-")) break;
    const split = arg.indexOf("=");
    const key = split < 0 ? arg : arg.slice(0, split);
    const value = () => {
      const result = split < 0 ? input[++i] : arg.slice(split + 1);
      if (!result || result.startsWith("--")) throw new EngineError(`${key} requires a value`, "BROWSER_INVALID_ARGUMENTS");
      return result;
    };
    switch (key) {
      case "--session": command.session = value(); break;
      case "--cdp": command.endpoint = value(); break;
      case "--timeout": command.timeout = positiveNumber(value(), "timeout"); break;
      case "--json": command.json = true; break;
      case "--no-auto-dialog":
        command.noAutoDialog = split >= 0 ? value() !== "false" : ["true", "false"].includes(input[i + 1]) ? input[++i] === "true" : true;
        break;
      case "--pin-tab": // Every command is explicitly bound to the selected page.
        if (["true", "false"].includes(input[i + 1])) i++;
        break;
      case "--help": case "-h": command.args = ["help"]; return command;
      case "--version": case "-V": command.args = ["version"]; return command;
      default: throw new EngineError(`Unsupported browser option: ${key}`, "BROWSER_INVALID_ARGUMENTS");
    }
  }
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(command.session) || command.session === "." || command.session === "..")
    throw new EngineError("Invalid browser session name", "BROWSER_INVALID_ARGUMENTS");
  command.args = input.slice(i);
  if (!command.args.length) command.args = ["help"];
  return command;
}

export function positiveNumber(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 300000) throw new EngineError(`Invalid ${label}: ${value}`, "BROWSER_INVALID_ARGUMENTS");
  return n;
}
export function required(value: string | undefined, label: string): string {
  if (value === undefined) throw new EngineError(`Missing ${label}`, "BROWSER_INVALID_ARGUMENTS");
  return value;
}
export function option(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) return required(args[i + 1], name);
      if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
    }
  }
  return undefined;
}
export const has = (args: string[], ...names: string[]) => args.some(arg => names.includes(arg));

/** Command data only: no shell expansion, interpolation or execution. */
export function splitCommand(line: string): string[] {
  const result: string[] = [];
  let value = "", quote = "", escaped = false, started = false;
  for (const character of line) {
    if (escaped) { value += character; escaped = false; started = true; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (character === quote) quote = ""; else value += character; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) { result.push(value); value = ""; started = false; } }
    else { value += character; started = true; }
  }
  if (quote || escaped) throw new EngineError("Unterminated quoted batch argument", "BROWSER_INVALID_ARGUMENTS");
  if (started) result.push(value);
  return result;
}

export const engineHelp = `ProfilePilot TypeScript browser engine ${ENGINE_VERSION}
Use ppilot browser --session TASK --cdp LOGICAL_PORT COMMAND

open URL | back | forward | reload
snapshot [-i] [-c] [-d DEPTH] [-s SELECTOR]
click SELECTOR [--new-tab] | dblclick SELECTOR | hover SELECTOR | focus SELECTOR
fill SELECTOR TEXT | type SELECTOR TEXT | select SELECTOR VALUE...
check SELECTOR | uncheck SELECTOR | upload SELECTOR FILE...
press KEY | keydown KEY | keyup KEY | keyboard type|inserttext TEXT
mouse move X Y | mouse down|up [BUTTON] | mouse wheel DY [DX]
scroll up|down|left|right [PX] [--selector SELECTOR]
scrollintoview SELECTOR | drag SOURCE TARGET
get text|html|value|attr|count|box|styles SELECTOR [ATTRIBUTE]
get title|url | is visible|enabled|checked SELECTOR
find role|text|label|placeholder|alt|title|testid QUERY ACTION [VALUE]
find first|last SELECTOR ACTION | find nth INDEX SELECTOR ACTION
wait SELECTOR|MS | wait --text TEXT | --url PATTERN | --load STATE | --fn JS
tab [list|new [URL]|close [ID]|ID] | window new [URL] | frame SELECTOR|main
screenshot [PATH] [--full] [--annotate] | pdf PATH
eval JS | eval --stdin | eval -b BASE64
download SELECTOR PATH | cookies [set NAME VALUE|clear]
storage local|session [KEY|set KEY VALUE|clear]
network route PATTERN [--abort|--body TEXT] | network unroute PATTERN
debug start|status|stop
network requests [--filter TEXT --type fetch,xhr --method POST --status 4xx --failed --since N --limit N]
network request ID [--offset N --text-limit N --no-body] | network clear | network routes
network har start [--content text|all|none] | network har stop [PATH]
profiler start | profiler stop [PATH] (Chrome performance trace JSON)
console | errors [--filter TEXT --level error --since N --limit N --clear]
dialog accept [TEXT] | dialog dismiss
set viewport W H | set geo LAT LON | set offline on|off
set headers JSON | set credentials USER PASSWORD | set media dark|light
state save|load PATH | console | errors | trace start|stop [PATH]
batch --stdin | batch "COMMAND"...
All refs belong to the latest snapshot and are invalidated by navigation.
Control: ppilot browser ... status|handoff|resume|complete|release
`;
