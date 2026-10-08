require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { FastBrowser } = require('../src/main/tasks/fast-browser.ts');
const { NativePage } = require('../src/main/tasks/native-page.ts');

function documentFixture(label = 'root', count = 1) {
  const nodes = [], style = { cursor: 'auto', visibility: 'visible', display: 'block', opacity: '1' };
  const body = { nodeType: 1, tagName: 'BODY', style, hasAttribute: () => false, getAttribute: () => null,
    innerText: 'long text '.repeat(3000) + 'END_OF_DOCUMENT', get childNodes() { return this.children || [{ nodeType: 3, textContent: this.innerText }]; } };
  const doc = { title: label, body, documentElement: { scrollHeight: 9999 },
    querySelectorAll: selector => selector === 'div,span,img,svg,li' ? [] : nodes,
    getElementById: () => undefined, elementFromPoint: () => doc.hit || nodes[0] };
  for (let index = 0; index < count; index++) nodes.push({ nodeType: 1, tagName: 'BUTTON', innerText: `${label}-${index}`, isConnected: true, style, childNodes: [],
    hasAttribute: () => false, getAttribute: () => null, querySelector: () => null, closest: () => null, getRootNode: () => doc,
    scrollIntoView: () => {}, getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, right: 50, top: 10, bottom: 30, width: 40, height: 20 }),
    contains: () => false });
  const context = vm.createContext({ document: doc, location: { href: `https://${label}.test/` }, innerWidth: 800, innerHeight: 600, getComputedStyle: el => el.style, Event: class {} });
  context.window = context;
  const evaluate = expression => {
    try { return { result: { value: vm.runInContext(expression, context) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  };
  const input = [];
  const browser = new FastBrowser(async () => {}, async (_task, method, params) => {
    if (method === 'Runtime.evaluate') return evaluate(params.expression);
    if (method.startsWith('Input.')) { input.push(params); return {}; }
    throw Error(method);
  });
  return { browser, evaluate, context, doc, nodes, input };
}

test('all 240 controls and text after 10000 characters are reachable with bounded pages', async () => {
  const f = documentFixture('long', 240), refs = new Set();
  let cursor, text = '', pageCount = 0;
  do {
    const page = await f.browser.observe({}, { cursor, limit: 45, textLimit: 2000 });
    assert.ok(page.fast.candidates.length <= 45); assert.ok(page.snapshot.length < 15000);
    for (const node of page.fast.candidates) refs.add(node.ref);
    text += page.snapshot; cursor = page.page.nextCursor;
    if (++pageCount > 30) throw Error('cursor did not terminate');
  } while (cursor);
  assert.equal(refs.size, 240); assert.match(text, /END_OF_DOCUMENT/);
  const search = await f.browser.observe({}, { query: 'long-239' });
  assert.equal(search.fast.candidates.length, 1); assert.equal(search.fast.candidates[0].label, 'long-239');
  const tail = await f.browser.observe({}, { query: 'END_OF_DOCUMENT' }); assert.match(tail.snapshot, /END_OF_DOCUMENT/);
});

test('cursor rejects a navigation and a changed result set instead of skipping content', async () => {
  for (const change of ['navigation', 'content']) {
    const f = documentFixture('long', 200), page = await f.browser.observe({});
    if (change === 'navigation') vm.runInContext('window.__profilepilot_jev_dom_v1=undefined', f.context);
    else f.nodes[150].innerText = 'changed';
    await assert.rejects(f.browser.observe({}, { cursor: page.page.nextCursor }), /分页内容已变化/);
  }
});

test('a control from later pages retains the exact range for action validation', async () => {
  const f = documentFixture('long', 200), first = await f.browser.observe({});
  const second = await f.browser.observe({}, { cursor: first.page.nextCursor });
  f.doc.hit = f.nodes[80];
  await f.browser.execute({ observation: second }, { kind: 'click', ref: second.fast.candidates[0].ref, effect: 'read' });
  assert.equal(f.input.length, 2);
});

test('scrolling an unrelated control offscreen does not invalidate guarded semantics', async () => {
  const f = documentFixture('scroll', 2), observation = await f.browser.observe({});
  f.nodes[1].getBoundingClientRect = () => ({ x: 10, y: 2000, left: 10, right: 50, top: 2000, bottom: 2020, width: 40, height: 20 });
  const fresh = await f.browser.observe({});
  assert.equal(fresh.fast.candidates[1].offscreen, true);
  assert.equal(fresh.fast.guard, observation.fast.guard);
  await f.browser.execute({ observation }, { kind: 'click', ref: observation.fast.candidates[0].ref, effect: 'read' });
  assert.equal(f.input.length, 2);
  f.nodes[1].innerText = 'changed meaning';
  await assert.rejects(f.browser.execute({ observation }, { kind: 'click', ref: observation.fast.candidates[0].ref, effect: 'edit' }), /页面内容已经变化/);
});

test('nested shadow controls and text are observed, and hit testing descends shadow roots', async () => {
  const f = documentFixture('shadow', 1), inner = { ...f.nodes[0], innerText: 'Deep shadow button' };
  f.doc.body.innerText = 'Short main document';
  const nested = { childNodes: [{ nodeType: 3, textContent: 'Deep shadow text' }], querySelectorAll: () => [inner], getElementById: () => null, elementFromPoint: () => inner };
  const host = { ...f.nodes[0], innerText: 'host', shadowRoot: nested };
  const root = { childNodes: [{ nodeType: 3, textContent: 'Shadow text' }, host], querySelectorAll: () => [host], getElementById: () => null, elementFromPoint: () => host };
  f.nodes[0].shadowRoot = root;
  f.doc.body.children = [{ nodeType: 3, textContent: f.doc.body.innerText }, f.nodes[0]];
  inner.getRootNode = () => nested;
  // Pointer discovery must not return semantic nodes again in this fixture.
  root.querySelectorAll = selector => selector === 'div,span,img,svg,li' ? [] : [host];
  nested.querySelectorAll = selector => selector === 'div,span,img,svg,li' ? [] : [inner];
  const observation = await f.browser.observe({});
  assert.match(observation.snapshot, /Deep shadow text/);
  const ref = observation.fast.candidates.find(c => c.label === 'Deep shadow button').ref;
  await f.browser.execute({ observation }, { kind: 'click', ref, effect: 'read' });
  assert.equal(f.input.length, 2);
});

function composedFixture() {
  const text = value => ({ nodeType: 3, textContent: value });
  const descend = root => root.childNodes.flatMap(child => child.nodeType === 1 ? [child, ...descend(child)] : []);
  const query = (root, selector) => {
    const nodes = descend(root);
    return selector === '*' ? nodes : selector === 'div,span,img,svg,li' ? [] : nodes.filter(node => ['A', 'BUTTON'].includes(node.tagName));
  };
  const element = (tagName, children = [], attrs = {}, style = {}) => {
    const node = { nodeType: 1, tagName, childNodes: children.map(child => typeof child === 'string' ? text(child) : child), attrs, isConnected: true,
      style: { display: /^(BODY|SECTION|H2|H3|PRE|P|DIV)$/.test(tagName) ? 'block' : 'inline', visibility: 'visible', opacity: '1', cursor: 'auto', whiteSpace: tagName === 'PRE' ? 'pre' : 'normal', ...style },
      getAttribute(name) { return this.attrs[name] ?? null; }, hasAttribute(name) { return name in this.attrs; },
      get textContent() { return this.childNodes.map(child => child.textContent).join(''); }, get innerText() { return this.textContent; },
      get href() { return this.attrs.href; },
      getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }),
      querySelectorAll(selector) { return query(this, selector); }, querySelector: () => null, closest: () => null,
      getRootNode() { return this.parentElement?.getRootNode() || doc; }
    };
    for (const child of node.childNodes) child.parentElement = node;
    return node;
  };
  const shadow = (host, children) => {
    const root = { nodeType: 11, host, childNodes: children, querySelectorAll(selector) { return query(this, selector); } };
    host.shadowRoot = root;
    return root;
  };
  const body = element('BODY'), doc = { title: 'Composed fixture', body, querySelectorAll: selector => query(body, selector), getElementById: () => null };
  const context = vm.createContext({ document: doc, location: { href: 'https://fixture.test/' }, innerWidth: 800, innerHeight: 600, getComputedStyle: el => el.style });
  context.window = context;
  const browser = new FastBrowser(async () => {}, async (_task, method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    try { return { result: { value: vm.runInContext(params.expression, context) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  });
  return { element, shadow, text, body, browser };
}

test('composed text keeps shadow syntax and release dates with their headings without CSS or comments', async () => {
  const f = composedFixture(), { element: el } = f;
  const code = el('MDN-CODE');
  f.shadow(code, [el('STYLE', ['.code { color: red; }']), { nodeType: 8, textContent: 'lit-part noise' },
    el('PRE', ['filter(callbackFn)\n  filter(callbackFn, thisArg)'])]);
  const date = el('RELATIVE-TIME', [], { datetime: '2026-09-04T22:40:31Z' });
  f.shadow(date, [el('STYLE', [':host { display: inline; }']), f.text('last month')]);
  f.body.childNodes = [el('H2', ['Syntax']), code, el('H2', ['Examples']), el('P', ['Example body']),
    el('SECTION', [el('H2', ['v1.63.0']), el('P', ['released this ', date]), el('H3', ['Test locks'])]),
    el('SCRIPT', ['privateScript()']), el('TEMPLATE', ['template noise']), el('DIV', ['hidden noise'], {}, { display: 'none' })];
  const page = await f.browser.observe({});
  assert.match(page.snapshot, /Syntax\s+filter\(callbackFn\)\n  filter\(callbackFn, thisArg\)\s+Examples/);
  assert.match(page.snapshot, /v1\.63\.0\s+released this last month \(2026-09-04T22:40:31Z\)\s+Test locks/);
  assert.doesNotMatch(page.snapshot, /color:|:host|lit-part|privateScript|template noise|hidden noise/);
  const syntax = await f.browser.observe({}, { query: 'Syntax' });
  assert.match(syntax.snapshot, /filter\(callbackFn, thisArg\)/);
  const released = await f.browser.observe({}, { query: 'released this' });
  assert.match(released.snapshot, /v1\.63\.0/); assert.match(released.snapshot, /2026-09-04T22:40:31Z/);
});

test('slots render assigned nodes once in composed order and suppress unused light and fallback content', async () => {
  const f = composedFixture(), { element: el } = f;
  const assigned = el('SPAN', ['assigned content']), unused = el('SPAN', ['unused light']);
  const host = el('CUSTOM-CARD', [assigned, unused]), slot = el('SLOT', ['unused fallback']);
  slot.assignedNodes = () => [assigned];
  const fallback = el('SLOT', ['visible fallback']); fallback.assignedNodes = () => [];
  const nested = el('INNER-CARD'); f.shadow(nested, [f.text('nested shadow')]);
  f.shadow(host, [f.text('before '), slot, f.text(' after '), nested, f.text(' '), fallback]);
  f.body.childNodes = [el('P', ['Start']), host, el('P', ['End'])];
  const page = await f.browser.observe({});
  assert.match(page.snapshot, /Start\s+before assigned content after nested shadow visible fallback\s+End/);
  assert.equal(page.snapshot.match(/assigned content/g).length, 1);
  assert.doesNotMatch(page.snapshot, /unused light|unused fallback/);
});

test('nested empty block and flex containers keep compact paragraph separators', async () => {
  const f = composedFixture(), { element: el } = f;
  let row = el('P', ['Issue title']);
  for (let depth = 0; depth < 40; depth++) row = el('DIV', [el('DIV'), '  ', row, el('DIV')], {}, { display: depth % 2 ? 'flex' : 'grid' });
  f.body.childNodes = [el('H2', ['Open issues']), row, el('P', ['Updated today'])];
  const page = await f.browser.observe({});
  const body = page.snapshot.split('\n\nControls:\n')[0];
  assert.equal(body, 'Open issues\n\nIssue title\n\nUpdated today');
  assert.equal(page.page.totalText, body.length);
  assert.doesNotMatch(body, /\n{3}/);
});

test('layout normalization preserves authored preformatted blank lines and edge indentation', async () => {
  const f = composedFixture(), { element: el } = f;
  const code = '  first\n\n\n\n    second\n  ';
  const wrapped = '  wrapped\n\n\n    last  ';
  const host = el('CODE-HOST');
  f.shadow(host, [el('DIV', [el('PRE', [code])]), el('DIV'), el('SPAN', [wrapped], {}, { whiteSpace: 'pre-wrap' })]);
  f.body.childNodes = [el('DIV', [host])];
  const body = (await f.browser.observe({})).snapshot.split('\n\nControls:\n')[0];
  assert.ok(body.startsWith(code), JSON.stringify(body));
  assert.ok(body.endsWith(wrapped), JSON.stringify(body));
  assert.ok(body.includes(code));
  assert.ok(body.includes(wrapped));
});

test('ordinary explicit line breaks and table cell boundaries remain readable', async () => {
  const f = composedFixture(), { element: el } = f;
  f.body.childNodes = [el('P', ['Line one', el('BR'), 'Line two', el('BR'), el('BR'), 'Paragraph']),
    el('TR', [el('TD', ['left'], {}, { display: 'table-cell' }), el('TD', ['right'], {}, { display: 'table-cell' })], {}, { display: 'table-row' })];
  const body = (await f.browser.observe({})).snapshot.split('\n\nControls:\n')[0];
  assert.equal(body, 'Line one\nLine two\n\nParagraph\n\nleft\tright');
});

test('observed links preserve search and anchor destinations while redacting explicit credentials', async () => {
  const f = composedFixture(), { element: el } = f;
  f.body.childNodes = [el('A', ['Search'], { href: 'https://example.test/search?q=AI%20agents&lang=en#latest' }),
    el('A', ['Release'], { href: 'https://github.com/microsoft/playwright/releases#v1.63.0' }),
    el('A', ['Private'], { href: 'https://user:password@example.test/view?q=hello&access%5Ftoken=private#token=secret&section=notes' })];
  const links = (await f.browser.observe({})).fast.candidates;
  assert.equal(links[0].href, 'https://example.test/search?q=AI%20agents&lang=en#latest');
  assert.equal(links[1].href, 'https://github.com/microsoft/playwright/releases#v1.63.0');
  assert.equal(links[2].href, 'https://example.test/view?q=hello&access%5Ftoken=[redacted]#token=[redacted]&section=notes');
});

test('OOPIF discovery recursively attaches and binds references to frame/context/session', async () => {
  const fixtures = { root: documentFixture('root'), child: documentFixture('child'), nested: documentFixture('nested') };
  const calls = [], contexts = { root: 1, child: 2, nested: 3 };
  let browser;
  const cdp = async (_task, method, params = {}, session) => {
    calls.push({ method, params, session });
    const id = session === 's2' ? 'nested' : session === 's1' ? 'child' : 'root';
    if (method === 'Target.setAutoAttach' && id !== 'nested') browser.event({ type: 'cdp', profileId: 'native:test', sessionId: 'task', cdpSessionId: session, method: 'Target.attachedToTarget', params: { sessionId: id === 'root' ? 's1' : 's2', targetInfo: { type: 'iframe' } } });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id, parentId: id === 'nested' ? 'child' : id === 'child' ? 'root' : undefined, url: `https://${id}.test/` } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: contexts[id] };
    if (method === 'Runtime.evaluate') {
      if (params.expression.includes('profilepilot-paint:')) return { result: { value: true } };
      assert.equal(params.contextId, contexts[id]); return fixtures[id].evaluate(params.expression);
    }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 99 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owner' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: params.arguments ? { x: params.arguments[0].value + 100, y: params.arguments[1].value + 50 } : undefined } };
    return {};
  };
  browser = new NativePage(cdp);
  const task = { profileId: 'native:test', sessionId: 'task' };
  const root = await browser.observe(task);
  assert.equal(root.frames.length, 3);
  task.observation = await browser.observe(task, { frameId: 'nested' });
  assert.notEqual(root.fast.candidates[0].ref, task.observation.fast.candidates[0].ref);
  const saved = task.observation;
  task.observation = undefined; // TaskService.perform clears stale DOM.
  task.observation = await browser.reobserve(task);
  assert.equal(task.observation.page.frameId, 'nested');
  assert.equal(task.observation.fast.candidates[0].ref, saved.fast.candidates[0].ref);
  await browser.execute(task, { kind: 'click', ref: task.observation.fast.candidates[0].ref, effect: 'read' });
  const click = calls.find(call => call.method === 'Input.dispatchMouseEvent');
  assert.equal(click.session, 's2'); assert.equal(click.params.x, 30); assert.equal(click.params.y, 20);
  fixtures.nested.context.location.href += 'navigated';
  await assert.rejects(browser.execute(task, { kind: 'click', ref: task.observation.fast.candidates[0].ref, effect: 'read' }), /页面内容已经变化/);
  browser.forget(task);
  await assert.rejects(browser.execute(task, { kind: 'click', ref: task.observation.fast.candidates[0].ref, effect: 'read' }), /引用已失效/);
});
