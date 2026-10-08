require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { FastBrowser, readLinkGuard } = require('../src/main/tasks/fast-browser.ts');
const { NativePage } = require('../src/main/tasks/native-page.ts');
const { effectiveEffect } = require('../src/main/tasks/browser.ts');

function pageFixture() {
  const nodes = [], events = [], inputs = [];
  class Input { get value() { return this._value || ''; } set value(value) { this._value = value; } }
  const doc = { title: 'Search feed', body: { innerText: 'Article feed' }, activeElement: null,
    querySelectorAll: selector => selector === 'div,span,img,svg,li' ? [] : nodes,
    getElementById: () => null, elementFromPoint: () => doc.hit || nodes[0] };
  const context = vm.createContext({ document: doc, location: { href: 'https://fixture.test/feed' }, innerWidth: 800, innerHeight: 600,
    getComputedStyle: node => node.style, HTMLInputElement: Input, HTMLTextAreaElement: Input, HTMLSelectElement: Input,
    Event: class { constructor(type) { this.type = type; } } });
  context.window = context;
  function node(tag, label, attrs = {}) {
    const el = Object.assign(new Input(), { tagName: tag, innerText: label, textContent: label, attrs, isConnected: true, parentElement: { textContent: '29 likes', closest: () => null },
      style: { cursor: 'pointer', visibility: 'visible', display: 'block', opacity: '1' },
      getAttribute: name => attrs[name] ?? null, getRootNode: () => doc, querySelector: () => null,
      closest: selector => selector === 'search,[role="search"]' ? el.landmark : selector.startsWith('label,fieldset,') ? el.recordContext : null,
      getBoundingClientRect: () => el.rect || ({ x: 10, y: 10, left: 10, right: 60, top: 10, bottom: 40, width: 50, height: 30 }),
      scrollIntoView: () => { events.push('scroll'); el.rect = undefined; }, focus: () => { doc.activeElement = el; },
      dispatchEvent: event => { events.push(event.type); }, contains: other => other === el });
    Object.defineProperty(el, 'href', { get: () => new URL(attrs.href || '', context.location.href).href });
    if (tag === 'INPUT') el.type = attrs.type || 'text';
    if (tag === 'BUTTON') el.type = attrs.type || 'submit';
    el.name = attrs.name || ''; nodes.push(el); return el;
  }
  function evaluate(expression) {
    try { return { result: { value: vm.runInContext(expression, context) } }; }
    catch (error) { return { exceptionDetails: { text: error.message } }; }
  }
  const browser = new FastBrowser(async () => {}, async (_task, method, params) => {
    if (method === 'Runtime.evaluate') return evaluate(params.expression);
    if (method.startsWith('Input.')) { inputs.push(params); return {}; }
    throw Error(method);
  });
  return { browser, nodes, node, doc, context, evaluate, events, inputs };
}
const action = (kind, ref, value, effect = 'read') => ({ kind, ref, value, effect, summary: '模型声称只是查看，不应作为分类依据' });

test('observed X-style and Xiaohongshu-style search inputs and focused Enter are read, independent of model summaries', async () => {
  for (const attrs of [{ type: 'search' }, { role: 'searchbox' }, { placeholder: '搜索小红书' }, { 'aria-label': 'Search query', role: 'combobox' }]) {
    const f = pageFixture(), input = f.node('INPUT', '', attrs);
    f.doc.activeElement = input;
    const observed = await f.browser.observe({}), ref = observed.fast.candidates[0].ref;
    assert.equal(effectiveEffect(action('fill', ref, 'AI', 'edit'), observed), 'read');
    assert.equal(effectiveEffect(action('press', ref, 'Enter', 'submit'), observed), 'read');
    assert.equal(effectiveEffect(action('press', undefined, 'Return', 'edit'), observed), 'read');
    assert.equal(effectiveEffect(action('press', ref, 'Control+Enter'), observed), 'submit');
    assert.equal(effectiveEffect(action('press', ref, 'Meta+Enter'), observed), 'submit');
    await f.browser.execute({ observation: observed }, action('fill', ref, 'OpenAI'));
    assert.equal(input.value, 'OpenAI'); assert.deepEqual(f.events.slice(-2), ['input', 'change']);
  }
});

test('POST forms, ordinary fields, editable posts and unfocused searches cannot become read-only Enter', async () => {
  for (const variant of ['post', 'mixed-form', 'ordinary', 'editable', 'focus']) {
    const f = pageFixture();
    const input = f.node(variant === 'editable' ? 'TEXTAREA' : 'INPUT', '', variant === 'ordinary' || variant === 'editable' ? {} : { placeholder: 'Search' });
    if (variant === 'post') input.form = { method: 'post', action: 'https://fixture.test/post', elements: [input] };
    if (variant === 'mixed-form') input.form = { method: 'get', elements: [input, { tagName: 'TEXTAREA', name: 'comment', value: 'pending post' }] };
    const other = f.node('BUTTON', 'Publish');
    f.doc.activeElement = variant === 'focus' ? other : input;
    const observed = await f.browser.observe({}), ref = observed.fast.candidates[0].ref;
    if (variant !== 'focus') assert.equal(effectiveEffect(action('fill', ref, 'text'), observed), 'edit', variant);
    assert.equal(effectiveEffect(action('press', ref, 'Enter'), observed), 'submit', variant);
  }
});

test('article titles mentioning publishing/saving stay navigation; actual write controls remain writes', async () => {
  const f = pageFixture();
  const cases = [
    ['A', '刚刚，GPT-6 Sol 和 Luna 发布，价格减半！', { href: '/search_result/note-id?source=feed' }, 'read'],
    ['A', 'How to save money when purchasing a computer', { href: '/articles/guide' }, 'read'],
    ['A', '订单详情', { href: '/orders/12' }, 'read'],
    ['A', '删除账号', { href: '/account/delete' }, 'delete'],
    ['BUTTON', '发布', {}, 'submit'], ['BUTTON', '点赞', {}, 'submit'], ['BUTTON', '收藏', {}, 'submit'],
    ['BUTTON', '391', { class: 'like-wrapper active' }, 'submit'], ['BUTTON', '68', { class: 'collect-wrapper' }, 'submit'],
    ['BUTTON', '购买', {}, 'purchase'], ['BUTTON', 'Send', {}, 'send'], ['BUTTON', '删除记录', {}, 'delete'],
    ['BUTTON', 'Continue', {}, 'submit']
  ];
  for (const [tag, label, attrs] of cases) { const el = f.node(tag, label, attrs); if (label === 'Continue') el.form = { method: 'post', elements: [el] }; }
  const observed = await f.browser.observe({});
  cases.forEach(([, label, , expected], index) => {
    const ref = observed.fast.candidates[index].ref;
    assert.equal(effectiveEffect(action('click', ref, undefined, expected === 'read' ? 'submit' : 'read'), observed), expected, label);
  });
  assert.equal(effectiveEffect(action('press', undefined, 'Escape', 'edit'), observed), 'read');
});

test('search GET submit is read but non-search form submission and unknown Enter stay guarded', async () => {
  const f = pageFixture(), input = f.node('INPUT', '', { type: 'search', name: 'q' }), search = f.node('BUTTON', 'Search');
  const form = { method: 'get', action: 'https://fixture.test/search', elements: [input, search] }; input.form = search.form = form;
  const observed = await f.browser.observe({});
  assert.equal(effectiveEffect(action('click', observed.fast.candidates[1].ref, undefined, 'submit'), observed), 'read');
  assert.equal(effectiveEffect(action('press', undefined, 'Enter'), observed), 'submit', 'focus must be proven');
  assert.equal(effectiveEffect(action('press', undefined, 'Enter'), undefined), 'submit');
  assert.equal(effectiveEffect(action('click', 'missing', undefined, 'purchase'), observed), 'purchase');
  assert.equal(effectiveEffect(action('click', 'e1'), { snapshot: '', fast: { candidates: [{ ref: 'e1', submit: true }] } }), 'submit', 'legacy candidates may omit label/role/kind');
});

test('form submit overrides and focused write controls cannot inherit search read permissions', async () => {
  for (const override of [{ formmethod: 'post' }, { formaction: 'https://fixture.test/purchase' }]) {
    const f = pageFixture(), input = f.node('INPUT', '', { type: 'search', name: 'q' }), submit = f.node('BUTTON', 'Search', override);
    const form = { method: 'get', action: 'https://fixture.test/search', elements: [input, submit] }; input.form = submit.form = form;
    f.doc.activeElement = input;
    const observed = await f.browser.observe({}), ref = observed.fast.candidates[0].ref;
    assert.equal(effectiveEffect(action('fill', ref, 'text'), observed), 'edit');
    assert.equal(effectiveEffect(action('press', ref, 'Enter'), observed), override.formaction ? 'purchase' : 'submit');
  }
  for (const [label, expected] of [['Purchase', 'purchase'], ['Delete account', 'delete'], ['Send message', 'send']]) {
    const f = pageFixture(), input = f.node('INPUT', '', { type: 'search' }), submit = f.node('BUTTON', label);
    const form = { method: 'get', action: 'https://fixture.test/search', elements: [input, submit] }; input.form = submit.form = form;
    for (const focused of [input, submit]) {
      f.doc.activeElement = focused;
      const observed = await f.browser.observe({}), ref = observed.fast.candidates[focused === input ? 0 : 1].ref;
      for (const value of ['Enter', 'Control+Enter', 'Meta+Enter']) assert.equal(effectiveEffect(action('press', ref, value), observed), expected, label + ' ' + value);
    }
  }
});

test('unrelated live-feed controls and nearby counters do not cancel a stable note link', async () => {
  const f = pageFixture(), link = f.node('A', 'GPT-6 发布新闻', { href: '/note/1?source=first' });
  const observation = await f.browser.observe({}), ref = observation.fast.candidates[0].ref;
  const click = action('click', ref, undefined, 'submit');
  const guarded = readLinkGuard(observation.fast.guard, click); assert.ok(guarded);
  link.parentElement.textContent = '30 likes, 8 bookmarks'; f.doc.body.innerText = 'A live feed update';
  for (let i = 0; i < 85; i++) { const unrelated = f.node('BUTTON', 'live count ' + i); f.nodes.unshift(f.nodes.pop()); }
  const fresh = await f.browser.reobserve({ observation });
  assert.notEqual(fresh.fingerprint, observation.fingerprint);
  assert.equal(readLinkGuard(fresh.fast.guard, click), guarded);
  f.doc.hit = link; await f.browser.execute({ observation }, click);
  assert.deepEqual(f.inputs.map(event => event.type), ['mousePressed', 'mouseReleased']);
});

test('stable-link relaxation rejects target identity, context, label, URL, href query, role, disable and handler changes', async () => {
  for (const change of ['replace', 'context', 'parent', 'context-role', 'context-label', 'label', 'url', 'href', 'role', 'disabled', 'aria-disabled', 'handler', 'covered']) {
    const f = pageFixture(), link = f.node('A', 'Read note', { href: '/note/1?token=one' });
    const observation = await f.browser.observe({}), click = action('click', observation.fast.candidates[0].ref);
    if (change === 'replace') { link.isConnected = false; f.nodes.length = 0; f.node('A', 'Read note', { href: '/note/1?token=one' }); }
    if (change === 'context') link.parentElement.textContent = 'Another account 30 likes';
    if (change === 'parent') link.parentElement = { ...link.parentElement };
    if (change === 'context-role') link.parentElement.getAttribute = name => name === 'role' ? 'dialog' : null;
    if (change === 'context-label') link.parentElement.getAttribute = name => name === 'aria-label' ? 'Another account' : null;
    if (change === 'label') link.innerText = 'Different note';
    if (change === 'url') f.context.location.href += '?different-page';
    if (change === 'href') link.attrs.href = '/note/1?token=two';
    if (change === 'role') link.attrs.role = 'button';
    if (change === 'disabled') link.disabled = true;
    if (change === 'aria-disabled') link.attrs['aria-disabled'] = 'true';
    if (change === 'handler') link.attrs.onclick = 'submitForm()';
    if (change === 'covered') f.doc.hit = { shadowRoot: undefined };
    await assert.rejects(f.browser.execute({ observation }, click), /变化|失效|遮挡/, change);
    assert.equal(f.inputs.length, 0, change);
  }
});

test('nearest article context protects account identity without guarding the entire feed section', async () => {
  const f = pageFixture(), link = f.node('A', 'Read note', { href: '/note/1' });
  link.recordContext = { textContent: 'Author 29 likes' };
  const observation = await f.browser.observe({}), click = action('click', observation.fast.candidates[0].ref);
  link.parentElement.textContent = f.doc.body.innerText = 'A different card was inserted into the feed section';
  link.recordContext.textContent = 'Author 30 likes';
  await f.browser.execute({ observation }, click);
  assert.equal(f.inputs.length, 2);
  link.recordContext.textContent = 'Another author 30 likes';
  await assert.rejects(f.browser.execute({ observation }, click), /变化/);
  assert.equal(f.inputs.length, 2);
});

test('offscreen filter hover scrolls to the target and reveals options without issuing clicks', async () => {
  const f = pageFixture(), filter = f.node('DIV', '筛选', { class: 'filter-container', onmouseenter: 'showFilter()' });
  filter.rect = { x: 10, y: 900, left: 10, right: 60, top: 900, bottom: 930, width: 50, height: 30 };
  const observation = await f.browser.observe({}), candidate = observation.fast.candidates[0];
  assert.equal(candidate.offscreen, true); assert.match(observation.snapshot, /hover can reveal options/);
  const originalRaw = f.browser.raw.bind(f.browser);
  f.browser.raw = async (...args) => { const result = await originalRaw(...args); if (args[1] === 'Input.dispatchMouseEvent' && args[2].type === 'mouseMoved') f.node('BUTTON', '最近 7 天'); return result; };
  await f.browser.execute({ observation }, action('hover', candidate.ref));
  assert.equal(f.events[0], 'scroll'); assert.deepEqual(f.inputs.map(event => event.type), ['mouseMoved']);
  assert.ok((await f.browser.observe({})).fast.candidates.some(candidate => candidate.label === '最近 7 天'));
});

test('native global refs retain targeted guards across frames and cancel frame navigation', async () => {
  const root = pageFixture(), child = pageFixture(); root.node('BUTTON', 'Root');
  const link = child.node('A', 'Read note', { href: '/note/1' }), input = child.node('INPUT', '', { type: 'search' }); child.doc.activeElement = input;
  let loader = 'child-document', browser; const calls = [];
  const cdp = async (_task, method, params = {}, session) => {
    calls.push({ method, params, session }); const isChild = session === 'child-session';
    if (method === 'Target.setAutoAttach' && !isChild) browser.event({ type: 'cdp', profileId: 'native:test', sessionId: 'session', method: 'Target.attachedToTarget', params: { sessionId: 'child-session', targetInfo: { type: 'iframe' } } });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: isChild ? 'child' : 'root', parentId: isChild ? 'root' : undefined, url: 'https://fixture.test/feed', loaderId: isChild ? loader : 'root-document' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: isChild ? 2 : 1 };
    if (method === 'Runtime.evaluate') return params.expression.includes('profilepilot-paint:') ? { result: { value: true } } : (isChild ? child : root).evaluate(params.expression);
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 9 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'frame-owner' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: params.arguments ? { x: params.arguments[0].value, y: params.arguments[1].value } : undefined } };
    return {};
  };
  browser = new NativePage(cdp); const task = { id: 'test', profileId: 'native:test', sessionId: 'session' };
  await browser.observe(task); task.observation = await browser.observe(task, { frameId: 'child' });
  const [note, search] = task.observation.fast.candidates;
  assert.notEqual(note.ref, task.observation.fast.native.refs[note.ref]);
  assert.equal(effectiveEffect(action('press', search.ref, 'Enter', 'submit'), task.observation), 'read');
  const click = action('click', note.ref, undefined, 'edit');
  link.parentElement.textContent = '30 likes'; child.node('BUTTON', 'new card');
  const refreshed = await browser.reobserve(task);
  assert.equal(readLinkGuard(task.observation.fast.guard, click), readLinkGuard(refreshed.fast.guard, click));
  await browser.execute(task, click);
  assert.equal(calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 2);
  await browser.press(task, action('press', search.ref, 'Enter'), { key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  const keys = calls.filter(call => call.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(keys.map(call => call.session), ['child-session', 'child-session']); assert.equal(keys[1].params.text, undefined);
  await assert.rejects(browser.press(task, action('press', note.ref, 'Enter'), { key: 'Enter' }), /变化|焦点/);
  loader = 'new-child-document';
  await assert.rejects(browser.execute(task, click), /引用已失效/);
  assert.equal(calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, 2);
});

test('native compositor wait revalidates target, frame and occlusion and never clicks without a painted frame', async () => {
  for (const change of ['href', 'context', 'role', 'disabled', 'covered', 'frame-loader', 'frame-url', 'document', 'paint']) {
    const f = pageFixture(), link = f.node('A', 'Read note', { href: '/note/1' });
    let loaderId = 'loader'; const inputs = [];
    const browser = new NativePage(async (_task, method, params = {}) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: f.context.location.href, loaderId } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('profilepilot-paint:')) {
          if (change === 'href') link.attrs.href = '/different';
          if (change === 'context') link.parentElement.textContent = 'Another account';
          if (change === 'role') link.attrs.role = 'button';
          if (change === 'disabled') link.disabled = true;
          if (change === 'covered') f.doc.hit = {};
          if (change === 'frame-loader') loaderId = 'new-loader';
          if (change === 'frame-url') f.context.location.href = 'https://fixture.test/another';
          if (change === 'document') vm.runInContext('window.__profilepilot_jev_dom_v1 = undefined', f.context);
          return { result: { value: change !== 'paint' } };
        }
        return f.evaluate(params.expression);
      }
      if (method.startsWith('Input.')) inputs.push(params); return {};
    });
    const task = { id: 'test', profileId: 'native:test', sessionId: 'session' }; task.observation = await browser.observe(task);
    await assert.rejects(browser.execute(task, action('click', task.observation.fast.candidates[0].ref)), /变化|失效|遮挡|输入帧|绘制帧/, change);
    assert.deepEqual(inputs, [], change);
  }
});

test('native offscreen links and submit buttons activate once at the composited position on Windows and macOS', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const system of ['win32', 'darwin']) for (const [tag, label, attrs, effect] of [
      ['A', '58 seconds ago', { href: '/note/1' }, 'read'], ['BUTTON', 'Submit', {}, 'submit'],
    ]) {
      Object.defineProperty(process, 'platform', { ...platform, value: system });
      const f = pageFixture(), link = f.node(tag, label, attrs);
      link.rect = { x: 10, y: 900, left: 10, right: 60, top: 900, bottom: 930, width: 50, height: 30 };
      let painted, activations = 0; const inputs = [];
      const scroll = link.scrollIntoView;
      link.scrollIntoView = () => { scroll(); painted = undefined; };
      const browser = new NativePage(async (_task, method, params = {}) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: f.context.location.href } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.evaluate') {
          if (params.expression.includes('profilepilot-paint:')) {
            // The renderer applies a layout shift while committing the scrolled frame.
            if (f.events.includes('scroll')) link.rect = { x: 40, y: 120, left: 40, right: 100, top: 120, bottom: 150, width: 60, height: 30 };
            const r = link.getBoundingClientRect(); painted = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            return { result: { value: true } };
          }
          return f.evaluate(params.expression);
        }
        if (method === 'Input.dispatchMouseEvent') {
          inputs.push(params);
          if (params.type === 'mouseReleased' && painted?.x === params.x && painted?.y === params.y) activations++;
        }
        return {};
      });
      const task = { id: 'test', profileId: 'native:test', sessionId: 'session' }; task.observation = await browser.observe(task);
      assert.equal(task.observation.fast.candidates[0].offscreen, true);
      await browser.execute(task, action('click', task.observation.fast.candidates[0].ref, undefined, effect));
      assert.equal(activations, 1, system + '/' + effect + ': the first click must use the frame painted after scrolling');
      assert.deepEqual(inputs.map(event => event.type), ['mousePressed', 'mouseReleased']);
      assert.deepEqual(inputs.map(event => [event.x, event.y]), [[70, 135], [70, 135]]);
      assert.deepEqual(f.events, ['scroll'], 'final validation must not scroll after the paint barrier');
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('Windows Gateway screenshot barrier also follows scrolling and preserves final hit testing', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    for (const covered of [false, true]) {
      const f = pageFixture(); f.node('BUTTON', 'Submit');
      const browser = new FastBrowser(async () => {}), calls = [];
      browser.raw = async (_task, method, params) => {
        calls.push(method);
        if (method === 'Runtime.evaluate') return f.evaluate(params.expression);
        if (method === 'Page.captureScreenshot') {
          assert.deepEqual(f.events, ['scroll']);
          if (covered) f.doc.hit = {};
        }
        return {};
      };
      const observation = await browser.observe({});
      const execute = browser.execute({ observation }, action('click', observation.fast.candidates[0].ref, undefined, 'submit'));
      if (covered) await assert.rejects(execute, /遮挡/); else await execute;
      assert.equal(calls.filter(method => method === 'Page.captureScreenshot').length, 1);
      assert.equal(calls.filter(method => method === 'Input.dispatchMouseEvent').length, covered ? 0 : 2);
      assert.deepEqual(f.events, ['scroll']);
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});
