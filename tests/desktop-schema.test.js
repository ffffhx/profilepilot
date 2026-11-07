const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { desktopActionSchema, desktopCommandSchema } = loadCli('src/main/desktop/schema.ts');
const version = 'b'.repeat(32), windowId = 'a'.repeat(32);
const action = (kind, fields = {}) => ({ version, kind, ...fields });
const command = (method, fields = {}) => ({ action: 'desktop', method, ...fields });
function accepts(schema, value) { const result = schema.safeParse(value); assert.equal(result.success, true, result.error?.message); }
function rejects(schema, value) { assert.equal(schema.safeParse(value).success, false, JSON.stringify(value)); }

test('semantic desktop actions require a reference and reject unrelated input fields', () => {
  for (const kind of ['invoke', 'toggle', 'select', 'expand', 'collapse', 'focus']) {
    accepts(desktopActionSchema, action(kind, { ref: 'e1' }));
    rejects(desktopActionSchema, action(kind));
    rejects(desktopActionSchema, action(kind, { ref: 'e1', value: '' }));
    rejects(desktopActionSchema, action(kind, { ref: 'e1', x: 1, y: 2 }));
  }
});

test('set_value never turns an omitted value into clearing a control', () => {
  accepts(desktopActionSchema, action('set_value', { ref: 'e1', value: '' }));
  accepts(desktopActionSchema, action('set_value', { ref: 'e1', value: '中文\n🙂' }));
  for (const fields of [{ ref: 'e1' }, { value: 'text' }, { ref: 'e1', value: undefined }, { ref: 'e1', value: null }]) {
    rejects(desktopActionSchema, action('set_value', fields));
  }
});

test('type_text rejects empty text and every C0/C1 control without rejecting Unicode', () => {
  accepts(desktopActionSchema, action('type_text', { value: '中文🙂 ' }));
  accepts(desktopActionSchema, action('type_text', { ref: 'e2', value: 'a'.repeat(512) }));
  accepts(desktopActionSchema, action('type_text', { ref: 'e2', value: '🧪'.repeat(256) }));
  for (const value of [undefined, '', 'a'.repeat(513), '\ud83d', '\ude00', 'a\ud83db']) rejects(desktopActionSchema, action('type_text', { value }));
  for (let code = 0; code <= 0x9f; code++) {
    if (code <= 0x1f || code >= 0x7f) rejects(desktopActionSchema, action('type_text', { value: `before${String.fromCharCode(code)}after` }));
  }
});

test('pointer actions accept exactly one reference or a complete coordinate pair', () => {
  for (const kind of ['click', 'double_click', 'move', 'drag', 'wheel']) {
    const extra = kind === 'drag' ? { toX: 10, toY: 20 } : kind === 'wheel' ? { deltaY: 120 } : {};
    accepts(desktopActionSchema, action(kind, { ref: 'e1', ...extra }));
    accepts(desktopActionSchema, action(kind, { x: 0, y: 8191, ...extra }));
    for (const position of [{}, { x: 1 }, { y: 2 }, { ref: 'e1', x: 1 }, { ref: 'e1', y: 2 }, { ref: 'e1', x: 1, y: 2 }]) {
      rejects(desktopActionSchema, action(kind, { ...position, ...extra }));
    }
  }
});

test('pointer-specific options cannot be silently ignored', () => {
  for (const kind of ['click', 'double_click', 'drag']) {
    const extra = kind === 'drag' ? { toX: 10, toY: 20 } : {};
    for (const button of ['left', 'right', 'middle']) accepts(desktopActionSchema, action(kind, { ref: 'e1', button, ...extra }));
    for (const button of ['back', '', 0, null]) rejects(desktopActionSchema, action(kind, { ref: 'e1', button, ...extra }));
  }
  rejects(desktopActionSchema, action('move', { x: 1, y: 2, button: 'left' }));
  rejects(desktopActionSchema, action('wheel', { ref: 'e1', deltaY: 120, button: 'middle' }));
  for (const fields of [{ keys: ['CTRL'] }, { value: 'text' }, { deltaY: 120 }, { toX: 2, toY: 3 }, { horizontal: 0 }]) {
    rejects(desktopActionSchema, action('click', { ref: 'e1', ...fields }));
  }
});

test('drag requires both destination coordinates and all coordinates are bounded integers', () => {
  for (const fields of [{}, { toX: 1 }, { toY: 2 }]) rejects(desktopActionSchema, action('drag', { ref: 'e1', ...fields }));
  for (const field of ['x', 'y', 'toX', 'toY']) {
    for (const value of [-1, 8192, 0.5, '10', NaN, Infinity]) {
      rejects(desktopActionSchema, action('drag', { x: 1, y: 2, toX: 3, toY: 4, [field]: value }));
    }
  }
});

test('wheel and semantic scroll require a bounded nonzero movement', () => {
  for (const fields of [{ deltaX: -1200 }, { deltaY: 1200 }, { deltaX: 0, deltaY: -1 }]) accepts(desktopActionSchema, action('wheel', { ref: 'e1', ...fields }));
  for (const fields of [{}, { deltaX: 0 }, { deltaX: 0, deltaY: 0 }, { deltaX: 1201 }, { deltaY: -1201 }, { deltaY: 0.5 }]) rejects(desktopActionSchema, action('wheel', { ref: 'e1', ...fields }));
  for (const fields of [{ horizontal: 0 }, { vertical: 4 }, { horizontal: 2, vertical: 1 }]) accepts(desktopActionSchema, action('scroll', { ref: 'e1', ...fields }));
  for (const fields of [{}, { horizontal: 2 }, { horizontal: 2, vertical: 2 }, { vertical: -1 }, { vertical: 5 }, { vertical: 1.5 }]) rejects(desktopActionSchema, action('scroll', { ref: 'e1', ...fields }));
  rejects(desktopActionSchema, action('scroll', { vertical: 0 }));
});

test('press_key requires a bounded key chord and keeps optional focus reference', () => {
  accepts(desktopActionSchema, action('press_key', { keys: ['CTRL', 'A'] }));
  accepts(desktopActionSchema, action('press_key', { ref: 'e1', keys: ['ENTER'] }));
  for (const keys of [undefined, [], [''], ['x'.repeat(21)], ['A', 'B', 'C', 'D', 'E', 'F'], [1]]) rejects(desktopActionSchema, action('press_key', { keys }));
  rejects(desktopActionSchema, action('press_key', { keys: ['A'], x: 1, y: 2 }));
});

test('press_key rejects duplicate keys and aliases without silently rewriting the chord', () => {
  for (const keys of [['CTRL', 'CONTROL'], ['ctrl', 'control'], ['ESC', 'ESCAPE'], ['escape', 'Esc'], ['A', 'a'], ['SHIFT', 'shift'], ['F1', 'f1']]) {
    const params = action('press_key', { ref: 'e1', keys });
    const before = structuredClone(params);
    rejects(desktopActionSchema, params);
    rejects(desktopCommandSchema, command('action', { session: 'chord', requestId: randomUUID(), params }));
    assert.deepEqual(params, before);
  }
  for (const keys of [['CONTROL', 'a'], ['ESCAPE', 'ENTER'], ['CTRL', 'SHIFT', 'A'], ['F1', 'F12']]) {
    const params = action('press_key', { keys });
    assert.deepEqual(desktopActionSchema.parse(params), params);
    accepts(desktopCommandSchema, command('action', { session: 'chord', requestId: randomUUID(), params }));
  }
});

test('action envelope rejects malformed identity and unknown fields', () => {
  const valid = action('invoke', { ref: 'e1' });
  for (const patch of [{ version: '' }, { version: 'B'.repeat(32) }, { ref: '1' }, { ref: null }, { kind: 'execute' }, { modifiers: ['CTRL'] }, { timeout: 1000 }]) rejects(desktopActionSchema, { ...valid, ...patch });
});

test('read-only desktop commands and doctor work without a session', () => {
  for (const method of ['status', 'windows', 'doctor']) {
    accepts(desktopCommandSchema, command(method));
    accepts(desktopCommandSchema, command(method, { session: 'legacy-read' }));
  }
  accepts(desktopCommandSchema, command('doctor', { windowId }));
  accepts(desktopCommandSchema, command('doctor', { windowId, session: undefined, params: undefined, requestId: undefined, screenshotOnly: undefined, observeAfter: undefined }));
  rejects(desktopCommandSchema, command('doctor', { windowId: 'invalid' }));
});

test('session commands require all routing and idempotency fields', () => {
  for (const method of ['claim', 'select', 'observe', 'screenshot', 'action', 'handoff', 'resume', 'complete', 'release']) rejects(desktopCommandSchema, command(method));
  for (const method of ['claim', 'select']) {
    accepts(desktopCommandSchema, command(method, { session: 'task', windowId }));
    rejects(desktopCommandSchema, command(method, { session: 'task' }));
  }
  for (const method of ['observe', 'screenshot', 'handoff', 'resume', 'complete', 'release']) accepts(desktopCommandSchema, command(method, { session: 'task' }));
  const input = command('action', { session: 'task', params: action('invoke', { ref: 'e1' }), requestId: randomUUID(), observeAfter: true });
  accepts(desktopCommandSchema, input);
  for (const field of ['session', 'params', 'requestId']) rejects(desktopCommandSchema, { ...input, [field]: undefined });
  rejects(desktopCommandSchema, { ...input, requestId: 'invalid' });
  accepts(desktopCommandSchema, command('screenshot', { session: 'task', screenshotOnly: true }));
});

test('command-specific fields and flags are rejected even when false', () => {
  for (const [method, fields] of [
    ['status', { windowId }], ['windows', { params: action('invoke', { ref: 'e1' }) }],
    ['doctor', { requestId: randomUUID() }], ['observe', { screenshotOnly: false }],
    ['screenshot', { observeAfter: false }], ['release', { windowId }],
    ['claim', { windowId, requestId: randomUUID() }], ['resume', { extra: true }]
  ]) rejects(desktopCommandSchema, command(method, { session: 'task', ...fields }));
});
