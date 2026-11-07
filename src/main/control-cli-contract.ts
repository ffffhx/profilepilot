/** Local command discovery never connects to or claims a target. */
export interface ControlCliCommand {
  summary: string;
  options: string[];
  required?: string[];
  example: string[];
  input?: Record<string, unknown>;
  notes?: string[];
}
export type ControlCliCommands = Record<string, ControlCliCommand>;

export function suggestedCommand(args: string[]) {
  const safe = /^[A-Za-z0-9_./:@=-]+$/;
  const quote = (value: string, shell: 'powershell' | 'posix') => safe.test(value) ? value
    : shell === 'powershell' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const argv = ['ppilot', ...args];
  return { argv, powershell: argv.map(arg => quote(arg, 'powershell')).join(' '), posix: argv.map(arg => quote(arg, 'posix')).join(' ') };
}

export function commandGuidance(group: string, command: string | undefined, commands: ControlCliCommands) {
  const entry = command && Object.hasOwn(commands, command) ? commands[command] : undefined;
  return entry ? { command, allowedOptions: entry.options, requiredOptions: entry.required || [],
    example: suggestedCommand([group, ...entry.example]), ...(entry.input ? { input: entry.input } : {}), notes: entry.notes || [] }
    : { availableCommands: Object.keys(commands), nextCommand: suggestedCommand([group, 'schema']) };
}

export function handleControlCliDiscovery(group: string, args: string[], commands: ControlCliCommands,
  io: Pick<NodeJS.Process, 'stdout' | 'stderr'>): boolean {
  const schema = args[0] === 'schema' || args[0] === 'capabilities';
  const help = args[0] === 'help' || args.includes('--help') || args.includes('-h');
  if (!schema && !help) return false;
  const selected = schema || args[0] === 'help' ? args[1] && !args[1].startsWith('-') ? args[1] : undefined : args[0]?.startsWith('-') ? undefined : args[0];
  if (selected && !Object.hasOwn(commands, selected)) throw new Error(`未知 ${group} 命令：${selected}`);
  if (schema) {
    if (args.some((value, index) => index > 0 && !(index === 1 && value === selected) && value !== '--json') || args.filter(value => value === '--json').length > 1) throw new Error('schema 仅接受一个命令名称和 --json。');
    const entries = selected ? { [selected]: commands[selected] } : commands;
    io.stdout.write(JSON.stringify({ ok: true, result: { version: 1, group, runtimeVerified: false,
      commands: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, { summary: entry.summary, ...commandGuidance(group, name, commands) }])),
      selection: '优先使用能够完成任务的专用 Skill、API 或 CLI；需要界面时选择目标专用入口。发现结果不授权操作，也不恢复控制。' } }) + '\n');
  } else if (selected) {
    const entry = commands[selected];
    io.stdout.write(`ppilot ${group} ${selected} — ${entry.summary}\n选项：${entry.options.join(' ') || '无'}\n必需：${(entry.required || []).join(' ') || '无'}\n` +
      `PowerShell: ${suggestedCommand([group, ...entry.example]).powershell}\nPOSIX: ${suggestedCommand([group, ...entry.example]).posix}\n` +
      (entry.input ? `JSON: ${JSON.stringify(entry.input)}\n` : '') + (entry.notes || []).map(note => note + '\n').join(''));
  } else return false;
  return true;
}
