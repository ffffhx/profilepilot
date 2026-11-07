import { z } from 'zod';

const sessionName = z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/);
export const desktopWindowIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const coordinate = z.number().int().min(0).max(8191);
const pointerKinds = new Set(['click', 'double_click', 'move', 'drag', 'wheel']);
const referenceKinds = new Set(['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'focus', 'restore', 'minimize', 'maximize']);
const actionFields = {
  invoke: ['ref'], set_value: ['ref', 'value'], toggle: ['ref'], select: ['ref'],
  expand: ['ref'], collapse: ['ref'], scroll: ['ref', 'horizontal', 'vertical'], focus: ['ref'],
  restore: ['ref'], minimize: ['ref'], maximize: ['ref'],
  click: ['ref', 'x', 'y', 'button'], double_click: ['ref', 'x', 'y', 'button'],
  move: ['ref', 'x', 'y'], drag: ['ref', 'x', 'y', 'toX', 'toY', 'button'],
  wheel: ['ref', 'x', 'y', 'deltaX', 'deltaY'], type_text: ['ref', 'value'], press_key: ['ref', 'keys']
} satisfies Record<string, string[]>;

// Keep a common object type for the service while rejecting fields that a
// particular action would otherwise silently ignore.
export const desktopActionSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{32}$/),
  kind: z.enum(['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'focus', 'restore', 'minimize', 'maximize', 'click', 'double_click', 'move', 'drag', 'wheel', 'type_text', 'press_key']),
  ref: z.string().regex(/^e\d+$/).optional(), value: z.string().max(16384).optional(),
  keys: z.array(z.string().min(1).max(20)).min(1).max(5).optional(),
  horizontal: z.number().int().min(0).max(4).optional(), vertical: z.number().int().min(0).max(4).optional(),
  x: coordinate.optional(), y: coordinate.optional(), toX: coordinate.optional(), toY: coordinate.optional(),
  deltaX: z.number().int().min(-1200).max(1200).optional(), deltaY: z.number().int().min(-1200).max(1200).optional(),
  button: z.enum(['left', 'right', 'middle']).optional()
}).strict().superRefine((action, ctx) => {
  const invalid = (field: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
  const allowed = new Set<string>(['version', 'kind', ...actionFields[action.kind]]);
  for (const [field, value] of Object.entries(action)) {
    if (value !== undefined && !allowed.has(field)) invalid(field, `${action.kind} 不支持 ${field}。`);
  }
  if (referenceKinds.has(action.kind) && action.ref === undefined) invalid('ref', `${action.kind} 需要 ref。`);
  if (pointerKinds.has(action.kind)) {
    if (action.ref !== undefined) {
      if (action.x !== undefined || action.y !== undefined) invalid('ref', 'ref 与 x/y 不能同时使用。');
    } else if (action.x === undefined || action.y === undefined) invalid('x', '指针操作需要 ref 或完整的 x/y。');
  }
  if (action.kind === 'drag' && (action.toX === undefined || action.toY === undefined)) invalid('toX', 'drag 需要完整的 toX/toY。');
  if (action.kind === 'wheel' && !(action.deltaX || action.deltaY)) invalid('deltaY', 'wheel 需要非零 deltaX/deltaY。');
  if (action.kind === 'scroll' && ![action.horizontal, action.vertical].some(value => value !== undefined && value !== 2)) {
    invalid('vertical', 'scroll 至少需要一个非 NoAmount(2) 的 horizontal/vertical。');
  }
  if (action.kind === 'set_value' && action.value === undefined) invalid('value', 'set_value 必须显式提供 value；空字符串表示清空。');
  if (action.kind === 'type_text') {
    if (!action.value) invalid('value', 'type_text 需要非空 value。');
    else if (/[\u0000-\u001f\u007f-\u009f]/u.test(action.value)) invalid('value', 'type_text 不接受控制字符；请用 press_key 输入控制键。');
    else if (action.value.length > 512) invalid('value', 'type_text 每次最多 512 个 UTF-16 单元；长文本请优先使用控件支持的 set_value，或分段输入并重新观察。');
    else if (/[\uD800-\uDFFF]/u.test(action.value)) invalid('value', 'type_text 不接受未配对的 UTF-16 代理项。');
  }
  if (action.kind === 'press_key' && action.keys === undefined) invalid('keys', 'press_key 需要 keys。');
  if (action.kind === 'press_key' && action.keys) {
    const aliases: Record<string, string> = { CONTROL: 'CTRL', ESCAPE: 'ESC' };
    const keys = action.keys.map(key => aliases[key.toUpperCase()] || key.toUpperCase());
    if (new Set(keys).size !== keys.length) invalid('keys', '组合键不能重复包含同一个键或其别名。');
  }
});

export const desktopWaitConditionSchema = z.object({
  name: z.string().max(512).optional(), role: z.string().min(1).max(100).optional(),
  automationId: z.string().min(1).max(512).optional(), text: z.string().max(4096).optional(),
  // TextPattern is an observation capability, not an input action kind.
  hasAction: z.enum(['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'focus', 'restore', 'minimize', 'maximize', 'click', 'double_click', 'move', 'drag', 'wheel', 'type_text', 'press_key', 'text']).optional()
}).strict().refine(value => Object.values(value).some(item => item !== undefined), '至少提供一个等待条件。');

const commandFields = {
  status: ['session'], doctor: ['session', 'windowId'], windows: ['session'],
  claim: ['session', 'windowId'], select: ['session', 'windowId'], observe: ['session'],
  screenshot: ['session', 'screenshotOnly'], wait: ['session', 'condition', 'timeoutMs', 'intervalMs'], action: ['session', 'params', 'requestId', 'observeAfter'],
  receipt: ['session', 'requestId'], handoff: ['session'], resume: ['session'], complete: ['session', 'requireActive'], release: ['session']
} satisfies Record<string, string[]>;

export const desktopCommandSchema = z.object({
  action: z.literal('desktop'),
  method: z.enum(['status', 'doctor', 'windows', 'claim', 'select', 'observe', 'screenshot', 'wait', 'action', 'receipt', 'handoff', 'resume', 'complete', 'release']),
  session: sessionName.optional(), windowId: desktopWindowIdSchema.optional(),
  params: desktopActionSchema.optional(), requestId: z.string().uuid().optional(),
  screenshotOnly: z.boolean().optional(), observeAfter: z.boolean().optional(), requireActive: z.boolean().optional(),
  condition: desktopWaitConditionSchema.optional(), timeoutMs: z.number().int().min(100).max(20000).optional(), intervalMs: z.number().int().min(100).max(2000).optional()
}).strict().superRefine((command, ctx) => {
  const invalid = (field: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
  const allowed = new Set<string>(['action', 'method', ...commandFields[command.method]]);
  // CLI construction includes optional properties with undefined values.
  for (const [field, value] of Object.entries(command)) {
    if (value !== undefined && !allowed.has(field)) invalid(field, `${command.method} 不支持 ${field}。`);
  }
  if (!['status', 'windows', 'doctor'].includes(command.method) && command.session === undefined) invalid('session', '需要 session 任务名。');
  if (['claim', 'select'].includes(command.method) && command.windowId === undefined) invalid('windowId', '需要 windowId。');
  if (command.method === 'wait' && command.condition === undefined) invalid('condition', 'wait 需要 condition。');
  if (command.method === 'receipt' && command.requestId === undefined) invalid('requestId', 'receipt 需要 requestId。');
  if (command.method === 'action') {
    if (command.params === undefined) invalid('params', 'action 需要 params。');
    if (command.requestId === undefined) invalid('requestId', 'action 需要 requestId。');
  }
});

export type DesktopCommand = z.infer<typeof desktopCommandSchema>;

/** Preserve Zod field constraints and expose the same per-kind field policy.
 * Keyboard aliases and native runtime evidence still require runtime checks. */
export function desktopActionJsonSchema() {
  const base = z.toJSONSchema(desktopActionSchema, { io: 'input' });
  const properties = base.properties || {};
  const fieldObject = (field: string) => typeof properties[field] === 'object' && properties[field] !== null ? properties[field] as Record<string, unknown> : {};
  return { ...base, oneOf: Object.entries(actionFields).map(([kind, fields]) => {
    const required = ['version', 'kind', ...(referenceKinds.has(kind) ? ['ref'] : []),
      ...(['set_value', 'type_text'].includes(kind) ? ['value'] : []), ...(kind === 'press_key' ? ['keys'] : []), ...(kind === 'drag' ? ['toX', 'toY'] : [])];
    const branches: unknown[] = [];
    if (pointerKinds.has(kind)) branches.push({ oneOf: [{ required: ['ref'], not: { anyOf: [{ required: ['x'] }, { required: ['y'] }] } }, { required: ['x', 'y'], not: { required: ['ref'] } }] });
    if (kind === 'wheel') branches.push({ anyOf: ['deltaX', 'deltaY'].map(field => ({ required: [field], properties: { [field]: { not: { const: 0 } } } })) });
    if (kind === 'scroll') branches.push({ anyOf: ['horizontal', 'vertical'].map(field => ({ required: [field], properties: { [field]: { enum: [0, 1, 3, 4] } } })) });
    const selected = Object.fromEntries(['version', 'kind', ...fields].map(field => [field, properties[field]]));
    if (kind === 'type_text') selected.value = { ...fieldObject('value'), minLength: 1, maxLength: 512, description: 'UTF-16 单元上限；禁止控制字符和未配对代理项。' };
    if (kind === 'press_key') selected.keys = { ...fieldObject('keys'), uniqueItems: true, description: '别名归一化后也不能重复，例如 CTRL 与 CONTROL。' };
    return { type: 'object', properties: { ...selected, kind: { const: kind } }, required, additionalProperties: false, ...(branches.length ? { allOf: branches } : {}) };
  }), 'x-runtimeChecks': ['观察版本、控件能力、坐标来源和接管状态由执行时重新校验。', '按 UTF-16 验证文本长度；press_key 在别名归一化后校验唯一性。'] };
}
