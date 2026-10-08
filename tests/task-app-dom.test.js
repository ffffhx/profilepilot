const test = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { loadTsModule } = require('./helpers/load-ts-module');

// Tree adapter only: verifies node reuse/reading-state logic without launching a
// browser. Native editing, focus and actual layout remain Electron CDP checks.
const parser = new DOMParser(), serialize = node => new XMLSerializer().serializeToString(node);
const initial = parser.parseFromString('<root/>', 'text/xml');
const elementPrototype = Object.getPrototypeOf(initial.documentElement);
function descendants(node) { return [...node.childNodes].flatMap(child => child.nodeType === 1 ? [child, ...descendants(child)] : []); }
function matches(node, selector) {
  return selector.split(',').some(part => {
    const value = part.trim();
    if (value[0] === '.') return (node.getAttribute('class') || '').split(' ').includes(value.slice(1));
    if (value[0] === '#') return node.id === value.slice(1);
    const match = /^([\w-]+)?(?:\[([\w-]+)\])?$/.exec(value);
    return !!match && (!match[1] || node.tagName === match[1]) && (!match[2] || node.hasAttribute(match[2]));
  });
}
for (const list of [initial.documentElement.childNodes, initial.documentElement.attributes]) {
  if (!list[Symbol.iterator]) Object.defineProperty(Object.getPrototypeOf(list), Symbol.iterator, { value: function* () { for (let i = 0; i < this.length; i++) yield this.item(i); } });
}
Object.assign(elementPrototype, {
  matches(selector) { return matches(this, selector); },
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); },
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  isEqualNode(other) { return serialize(this) === serialize(other); },
  getBoundingClientRect() { return this.rect || { top: 0, bottom: 100, height: 87 }; }
});
Object.defineProperty(elementPrototype, 'id', { configurable: true, get() { return this.getAttribute('id') || ''; } });
Object.defineProperty(elementPrototype, 'style', { configurable: true, get() { if (!this._testStyle) { const values = new Map(); this._testStyle = { setProperty: (key, value) => values.set(key, value), getPropertyValue: key => values.get(key) || '' }; } return this._testStyle; } });
Object.defineProperty(elementPrototype, 'dataset', { configurable: true, get() { const node = this; return new Proxy({}, { get(_, key) { return node.getAttribute('data-' + String(key).replace(/[A-Z]/g, x => '-' + x.toLowerCase())) || undefined; }, set(_, key, value) { node.setAttribute('data-' + String(key).replace(/[A-Z]/g, x => '-' + x.toLowerCase()), value); return true; } }); } });
const type = predicate => class { static [Symbol.hasInstance](value) { return !!value && predicate(value); } };
global.Element = type(node => node.nodeType === 1);
global.HTMLTextAreaElement = type(node => node.tagName === 'textarea');
global.HTMLDetailsElement = type(node => node.tagName === 'details');
global.Node = { TEXT_NODE: 3 };
let currentRoot;
const storage = new Map();
global.sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
global.document = {
  createElement(name) { assert.equal(name, 'template'); return { set innerHTML(markup) { this.content = parser.parseFromString(`<fragment>${markup}</fragment>`, 'text/xml').documentElement; } }; },
  getElementById(id) { return currentRoot.querySelector('#' + id); }
};
global.window = { innerHeight: 800 };
const { TaskDom, autoGrow, taskLatestScrollTop, isAtTaskLatest, jumpOverlapsReply, scrollToTaskLatest, revealTaskReply, syncTaskScrollInsets } = loadTsModule('src/renderer/task-interaction-dom.ts');
const fixture = () => { storage.clear(); currentRoot = parser.parseFromString('<root/>', 'text/xml').documentElement; return new TaskDom(currentRoot); };

test('#6 same-task snapshots retain textarea and unchanged transcript text node identity', () => {
  const dom = fixture(); const markup = '<main><article id="message">Selected text</article><form id="steer"><textarea data-editor-key="A">initial</textarea></form></main>';
  dom.update(markup, 'A');
  const editor = currentRoot.querySelector('textarea'), textNode = currentRoot.querySelector('#message').firstChild;
  editor.liveValue = 'user is typing'; editor.nativeUndoSentinel = { edits: ['one', 'two'] };
  dom.update(markup.replace('</article>', '</article><p>new event</p>'), 'A');
  assert.equal(currentRoot.querySelector('textarea'), editor); assert.equal(editor.liveValue, 'user is typing');
  assert.equal(currentRoot.querySelector('#message').firstChild, textNode);
  assert.deepEqual(editor.nativeUndoSentinel.edits, ['one', 'two']);
});
test('#4/#6 new decision does not reuse previous answer; ordinary composer survives insertion', () => {
  const dom = fixture(), compose = '<form id="steer"><textarea data-editor-key="ordinary">draft</textarea></form>';
  dom.update(`<main>${compose}</main>`, 'A'); const ordinary = currentRoot.querySelector('textarea');
  dom.update(`<main><form id="reply" data-decision-id="q1"><textarea data-editor-key="q1">first</textarea></form>${compose}</main>`, 'A');
  const first = currentRoot.querySelectorAll('textarea')[0];
  dom.update(`<main><form id="reply" data-decision-id="q2"><textarea data-editor-key="q2">second</textarea></form>${compose}</main>`, 'A');
  assert.notEqual(currentRoot.querySelectorAll('textarea')[0], first); assert.equal(currentRoot.querySelectorAll('textarea')[1], ordinary);
});
test('#6 cross-page return reattaches same editor node with internal state', () => {
  const dom = fixture(), markup = '<main><textarea data-editor-key="A">draft</textarea></main>';
  dom.update(markup, 'A'); const editor = currentRoot.querySelector('textarea'); editor.scrollTop = 90; editor.selectionDirection = 'backward';
  dom.update('<main><section>materials</section></main>', 'materials');
  dom.update(markup, 'A'); assert.equal(currentRoot.querySelector('textarea'), editor); assert.equal(editor.scrollTop, 90); assert.equal(editor.selectionDirection, 'backward');
});
test('#11 per-task reading position and expanded details survive navigation and session reconstruction', () => {
  const dom = fixture(), markup = '<main class="workspace"><details id="tool"><summary>Tools</summary></details></main>';
  dom.update(markup, 'A'); let workspace = currentRoot.querySelector('.workspace');
  workspace.scrollTop = 140; workspace.scrollHeight = 1500; workspace.clientHeight = 500; workspace.querySelector('details').open = true;
  dom.capture(); dom.update('<main class="workspace"><section>B</section></main>', 'B'); dom.update(markup, 'A'); dom.restore();
  workspace = currentRoot.querySelector('.workspace'); assert.equal(workspace.scrollTop, 140); assert.equal(workspace.querySelector('details').open, true);
  const fresh = new TaskDom(currentRoot); fresh.update(markup, 'A'); workspace.scrollTop = 0; fresh.restore(); assert.equal(workspace.scrollTop, 140);
});
test('#10 bottom readers follow new content; readers above the bottom retain position', () => {
  const dom = fixture(); dom.update('<main class="workspace"><p>Messages</p></main>', 'A'); const workspace = currentRoot.querySelector('.workspace');
  workspace.clientHeight = 500; workspace.scrollHeight = 900; workspace.scrollTop = 400; dom.capture(); workspace.scrollHeight = 1200; dom.restore(); assert.equal(workspace.scrollTop, 700);
  workspace.scrollTop = 150; dom.capture(); workspace.scrollHeight = 1600; dom.restore(); assert.equal(workspace.scrollTop, 150);
});

function threadLayout() {
  const dom = fixture();
  dom.update('<main class="workspace"><section class="thread-main"><div id="events"><article id="old-message" data-message-id="old">Old message</article></div><form id="steer-task">Composer</form></section><aside id="task-inspector">Tall inspector after conversation</aside></main>', 'A');
  const workspace = currentRoot.querySelector('.workspace'), composer = currentRoot.querySelector('#steer-task');
  workspace.rect = { top: 50, bottom: 750, height: 700 }; workspace.clientHeight = 700; workspace.scrollHeight = 4800; workspace.scrollTop = 0;
  let composerBottom = 2800;
  composer.getBoundingClientRect = () => ({ top: 50 + composerBottom - 300 - workspace.scrollTop, bottom: 50 + composerBottom - workspace.scrollTop, height: 300 });
  return { dom, workspace, composer, moveComposer: amount => { composerBottom += amount; } };
}
test('#10 first history open ends at the composer before a tall in-flow inspector', () => {
  const { dom, workspace, composer } = threadLayout(); dom.restore();
  assert.equal(workspace.scrollTop, 2116); assert.equal(composer.getBoundingClientRect().bottom, 734);
  assert.equal(isAtTaskLatest(workspace), true); assert.notEqual(workspace.scrollTop, workspace.scrollHeight - workspace.clientHeight);
});
test('#10 return-to-latest from inspector uses composer geometry, independent of inspector height', () => {
  const { workspace, composer } = threadLayout(); workspace.scrollTop = 4100;
  assert.equal(isAtTaskLatest(workspace), false); assert.equal(taskLatestScrollTop(workspace), 2116);
  workspace.scrollHeight += 2400; scrollToTaskLatest(workspace);
  assert.equal(workspace.scrollTop, 2116); assert.equal(composer.getBoundingClientRect().bottom, 734);
});
test('sticky composer cannot make an earlier reading position look latest', () => {
  const { workspace, composer } = threadLayout();
  const end = parser.parseFromString('<div id="task-thread-end"/>', 'text/xml').documentElement;
  workspace.querySelector('.thread-main').appendChild(end);
  composer.getBoundingClientRect = () => ({ bottom: 734 }); // Sticky: fixed in the viewport while content scrolls.
  end.getBoundingClientRect = () => ({ bottom: 50 + 2800 - workspace.scrollTop });
  workspace.scrollTop = 900;
  assert.equal(taskLatestScrollTop(workspace), 2116); assert.equal(isAtTaskLatest(workspace), false);
  scrollToTaskLatest(workspace); assert.equal(workspace.scrollTop, 2116); assert.equal(isAtTaskLatest(workspace), true);
});
test('latest shortcut avoids the whole visible decision control, including label edges', () => {
  const dom = fixture();
  dom.update('<main class="workspace"><form id="reply-task"><textarea id="answer"/><button id="approve"/><button id="reject"/></form><button class="task-jump-latest"/></main>', 'A');
  const workspace = currentRoot.querySelector('.workspace'), jump = workspace.querySelector('.task-jump-latest');
  jump.rect = { left: 560, right: 690, top: 620, bottom: 660, width: 130, height: 40 };
  workspace.querySelector('#answer').rect = { left: 320, right: 900, top: 380, bottom: 470, width: 580, height: 90 };
  workspace.querySelector('#approve').rect = { left: 326, right: 454, top: 619, bottom: 660, width: 128, height: 41 };
  const reject = workspace.querySelector('#reject');
  reject.rect = { left: 462, right: 624, top: 619, bottom: 660, width: 162, height: 41 };
  assert.equal(jumpOverlapsReply(workspace, jump), true);
  reject.rect = { left: 462, right: 624, top: 760, bottom: 801, width: 162, height: 41 };
  assert.equal(jumpOverlapsReply(workspace, jump), false);
});
test('#10 conversation followers track message/composer growth without following the inspector', () => {
  const { dom, workspace, moveComposer } = threadLayout(); dom.restore(); dom.capture();
  moveComposer(240); workspace.scrollHeight += 240; dom.restore(); assert.equal(workspace.scrollTop, 2356);
  dom.capture(); workspace.scrollHeight += 900; dom.restore(); assert.equal(workspace.scrollTop, 2356);
});
test('#10 hiding an in-flow jump button does not leave the latest position stale', () => {
  const { workspace, composer } = threadLayout();
  const button = parser.parseFromString('<button class="task-jump-latest"/>', 'text/xml').documentElement; workspace.appendChild(button); button.hidden = false;
  composer.getBoundingClientRect = () => ({ bottom: 50 + 2800 + (button.hidden ? 0 : 50) - workspace.scrollTop });
  scrollToTaskLatest(workspace); assert.equal(button.hidden, true); assert.equal(workspace.scrollTop, 2116); assert.equal(isAtTaskLatest(workspace), true);
});
test('#11 user reading inside inspector keeps that position when new messages arrive', () => {
  const { dom, workspace, moveComposer } = threadLayout(); workspace.scrollTop = 3500; dom.capture();
  moveComposer(240); workspace.scrollHeight += 240; dom.restore(); assert.equal(workspace.scrollTop, 3500);
  assert.equal(isAtTaskLatest(workspace), false);
});
test('#11 above-latest message anchor retains its viewport offset after earlier content grows', () => {
  const { dom, workspace } = threadLayout(); const anchor = currentRoot.querySelector('#old-message');
  let anchorTop = 800; anchor.getBoundingClientRect = () => ({ top: 50 + anchorTop - workspace.scrollTop, bottom: 150 + anchorTop - workspace.scrollTop, height: 100 });
  workspace.scrollTop = 780; dom.capture(); anchorTop += 180; workspace.scrollHeight += 180; dom.restore();
  assert.equal(workspace.scrollTop, 960); assert.equal(anchor.getBoundingClientRect().top, 70);
});
test('a new pending decision is revealed from latest without moving a history reader', () => {
  const markup = '<main class="workspace"><section class="thread-main"><form id="reply-task" data-decision-id="q1"><textarea id="answer"/></form><div id="events"><article id="old-message" data-message-id="old">Old message</article></div><form id="steer-task">Composer</form></section></main>';
  for (const readingHistory of [false, true]) {
    const { dom, workspace, moveComposer } = threadLayout();
    if (readingHistory) workspace.scrollTop = 900;
    else { dom.restore(); assert.equal(workspace.scrollTop, 2116); }
    const before = workspace.scrollTop;
    dom.update(markup, 'A'); moveComposer(700); workspace.scrollHeight += 700;
    const form = workspace.querySelector('#reply-task');
    form.getBoundingClientRect = () => ({ top: 50 + 2400 - workspace.scrollTop, bottom: 50 + 2700 - workspace.scrollTop, height: 300 });
    dom.restore();
    assert.equal(workspace.scrollTop, before);
    if (!readingHistory) assert.ok(form.getBoundingClientRect().top >= 50 && form.getBoundingClientRect().bottom <= 750);
  }
});
test('#7 auto-grow caps long input to viewport, preserves internal scroll and shrinks after clear', () => {
  const field = { matches: () => true, dataset: {}, style: {}, scrollHeight: 518, scrollTop: 23, getBoundingClientRect() { return { height: Number.parseFloat(this.style.height) || 87 }; } };
  autoGrow(field); assert.equal(field.style.height, '360px'); assert.equal(field.scrollTop, 23); assert.equal(field.style.overflowY, 'auto');
  field.scrollHeight = 30; autoGrow(field); assert.equal(field.style.height, '87px');
  window.innerHeight = 300; field.scrollHeight = 900; autoGrow(field); assert.equal(field.style.height, '135px'); window.innerHeight = 800;
});
test('compact composer auto-grow starts at 44px and preserves manual height', () => {
  const field = { matches: () => true, dataset: { autogrowMin: '44' }, style: {}, scrollHeight: 30, scrollTop: 0, getBoundingClientRect() { return { height: Number.parseFloat(this.style.height) || 44 }; } };
  autoGrow(field); assert.equal(field.style.height, '44px');
  field.scrollHeight = 140; autoGrow(field); assert.equal(field.style.height, '142px');
  field.dataset.manualHeight = '180'; field.scrollHeight = 30; autoGrow(field); assert.equal(field.style.height, '180px');
});
test('snapshot patch preserves nativebrowser live canvas bitmap dimensions and visibility', () => {
  const dom = fixture(); dom.update('<main><canvas class="live-canvas" hidden=""/></main>', 'A');
  const canvas = currentRoot.querySelector('canvas'); canvas.removeAttribute('hidden'); canvas.setAttribute('width', '1280'); canvas.setAttribute('height', '720');
  dom.update('<main><canvas class="live-canvas" hidden=""/><p>new snapshot</p></main>', 'A');
  assert.equal(currentRoot.querySelector('canvas'), canvas); assert.equal(canvas.hasAttribute('hidden'), false); assert.equal(canvas.getAttribute('width'), '1280');
});

function replyLayout({ cardTop = 400, cardHeight = 300, editorOffset = 100, editorHeight = 90, actionsOffset = 240, scrollTop = 400 } = {}) {
  const dom = fixture();
  dom.update('<main class="workspace"><header class="page-header"/><div class="task-thread-status"/><form id="reply-task"><textarea id="answer"/><button id="approve" type="submit">Approve</button></form><div id="events"/><form id="steer-task"/></main>', 'pending');
  const workspace = currentRoot.querySelector('.workspace'); workspace.rect = { top: 0, bottom: 700, height: 700 }; workspace.clientHeight = 700; workspace.scrollHeight = 5000; workspace.scrollTop = scrollTop;
  workspace.querySelector('.page-header').rect = { top: 0, bottom: 56, height: 56 };
  workspace.querySelector('.task-thread-status').rect = { top: 56, bottom: 220, height: 164 };
  const form = workspace.querySelector('#reply-task'), editor = workspace.querySelector('#answer'), approve = workspace.querySelector('#approve');
  form.getBoundingClientRect = () => ({ top: cardTop - workspace.scrollTop, bottom: cardTop + cardHeight - workspace.scrollTop, height: cardHeight });
  editor.getBoundingClientRect = () => ({ top: cardTop + editorOffset - workspace.scrollTop, bottom: cardTop + editorOffset + editorHeight - workspace.scrollTop, height: editorHeight });
  approve.getBoundingClientRect = () => ({ top: cardTop + actionsOffset - workspace.scrollTop, bottom: cardTop + actionsOffset + 36 - workspace.scrollTop, height: 36 });
  // The XML adapter supports structural selectors; submit buttons are returned
  // explicitly here to model the form controls' real geometry.
  form.querySelectorAll = selector => selector === 'button[type="submit"]' ? [approve] : descendants(form).filter(node => matches(node, selector));
  editor.focus = options => { editor.focusOptions = options; };
  workspace.querySelector('#steer-task').getBoundingClientRect = () => ({ bottom: 3000 - workspace.scrollTop });
  return { dom, workspace, form, editor, approve };
}
test('#28 focus-reply reveals the editor and approval button below the measured sticky bars', () => {
  const { workspace, form, editor, approve } = replyLayout(); revealTaskReply(workspace, true);
  assert.deepEqual(editor.focusOptions, { preventScroll: true });
  assert.equal(form.getBoundingClientRect().top, 232); assert.ok(approve.getBoundingClientRect().bottom <= 684);
});
test('#28 a long question focuses its reply controls without requiring the whole card to fit', () => {
  const { workspace, editor, approve } = replyLayout({ cardHeight: 1000, editorOffset: 750, actionsOffset: 920, scrollTop: 1000 });
  revealTaskReply(workspace, true); assert.equal(editor.getBoundingClientRect().top, 232); assert.ok(approve.getBoundingClientRect().bottom <= 684);
});
test('#28 first pending-task visit reveals the question rather than jumping to the ordinary composer', () => {
  const { dom, workspace, form } = replyLayout({ scrollTop: 3000 }); dom.restore();
  assert.equal(form.getBoundingClientRect().top, 232); assert.equal(workspace.scrollTop, 168);
});
test('#28 revisiting a pending task preserves an existing reading position', () => {
  const { dom, workspace } = replyLayout({ scrollTop: 900 }); dom.capture(); workspace.scrollTop = 0; dom.restore();
  assert.equal(workspace.scrollTop, 900);
});
test('#28 scroll insets use measured header/status heights and refresh after layout changes', () => {
  const { dom, workspace } = replyLayout(); dom.restore();
  assert.equal(workspace.style.getPropertyValue('--task-header-height'), '56px'); assert.equal(workspace.style.getPropertyValue('--task-sticky-height'), '164px');
  workspace.querySelector('.page-header').rect = { top: 0, bottom: 64, height: 64 };
  workspace.querySelector('.task-thread-status').rect = { top: 64, bottom: 284, height: 220 };
  syncTaskScrollInsets(workspace); assert.equal(workspace.style.getPropertyValue('--task-header-height'), '64px'); assert.equal(workspace.style.getPropertyValue('--task-sticky-height'), '220px');
  workspace.style.setProperty('--task-header-height', ''); workspace.style.setProperty('--task-sticky-height', ''); dom.restore();
  assert.equal(workspace.style.getPropertyValue('--task-header-height'), '64px'); assert.equal(workspace.style.getPropertyValue('--task-sticky-height'), '220px');
});
