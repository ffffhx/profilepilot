require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { FastBrowser, FastBrowserPageError } = require('../src/main/tasks/fast-browser.ts');

function fixture() {
  const context = vm.createContext({ crypto: {}, location: { href: 'about:blank' }, getComputedStyle: el => el.style || {}, document: { title: '', body: { innerText: '' }, querySelectorAll: () => [] } });
  context.window = context;
  const browser = new FastBrowser(async () => {});
  browser.raw = async (_task, _method, { expression }) => {
    try { return { result: { value: vm.runInContext(expression, context) } }; }
    catch (error) { return { exceptionDetails: { exception: { description: `${error.name}: ${error.message}` } } }; }
  };
  return { browser, context };
}

test('fast observation works without browser crypto.randomUUID and keeps document identity stable', async () => {
  const { browser, context } = fixture();
  const first = await browser.observe({});
  const second = await browser.observe({});
  assert.equal(first.url, 'about:blank'); assert.equal(first.fast.candidates.length, 0);
  assert.ok(first.fast.document); assert.equal(first.fast.document, second.fast.document);
  assert.equal(first.fingerprint, second.fingerprint);
  vm.runInContext('window.__profilepilot_jev_dom_v1 = undefined', context);
  const navigated = await browser.observe({});
  assert.notEqual(first.fast.document, navigated.fast.document);
  assert.notEqual(first.fingerprint, navigated.fingerprint);
});

test('a freshly observed page can execute a supported action without browser crypto', async () => {
  const { browser, context } = fixture();
  let scrolls = 0;
  context.scrollBy = () => scrolls++;
  const task = { observation: await browser.observe({}) };
  await browser.execute(task, { kind: 'scroll', value: 'down' });
  assert.equal(scrolls, 1);
});

test('horizontal scroll changes the horizontal axis and rejects unknown directions', async () => {
  const { browser, context } = fixture();
  const offsets = [];
  context.scrollBy = offset => offsets.push(offset);
  context.innerWidth = 800; context.innerHeight = 600;
  context.document.documentElement = { scrollWidth: 1400, scrollHeight: 600 };
  const task = { observation: await browser.observe({}) };
  assert.equal(task.observation.viewport.scrollWidth, 1400);
  await browser.execute(task, { kind: 'scroll', value: 'right' });
  await browser.execute(task, { kind: 'scroll', value: 'left' });
  assert.deepEqual(offsets.map(o => [o.left, o.top]), [[600, 0], [-600, 0]]);
  await assert.rejects(browser.execute(task, { kind: 'scroll', value: 'diagonal' }), /不支持的滚动方向/);
  assert.equal(offsets.length, 2);
});

test('page changes still reject stale actions with the actual reason', async () => {
  const { browser, context } = fixture();
  const task = { observation: await browser.observe({}) };
  context.location.href = 'https://example.test/changed';
  await assert.rejects(browser.execute(task, { kind: 'scroll', value: 'down' }), error => {
    assert.ok(error instanceof FastBrowserPageError); assert.equal(error.phase, 'execute');
    assert.match(error.message, /页面内容已经变化/); return true;
  });
});

test('snapshot errors identify the read phase and retain the original exception', async () => {
  const { browser } = fixture();
  browser.raw = async () => ({ exceptionDetails: { exception: { description: 'TypeError: crypto.randomUUID is not a function\n    at pageSnapshot:5' } } });
  await assert.rejects(browser.observe({}), error => {
    assert.ok(error instanceof FastBrowserPageError); assert.equal(error.phase, 'observe');
    assert.equal(error.message, '快速页面读取失败：TypeError: crypto.randomUUID is not a function');
    return true;
  });
});

test('exception messages omit credentials, URL queries and stack traces', async () => {
  const { browser } = fixture();
  browser.raw = async () => ({ exceptionDetails: { exception: { description: 'Error: https://user:secret@example.test/page?token=query-secret#private token=inline-secret Bearer bearer-secret\n    at private-stack' } } });
  await assert.rejects(browser.observe({}), error => {
    assert.match(error.message, /https:\/\/example.test\/page/);
    assert.doesNotMatch(error.message, /secret|private|user:/); return true;
  });
});

test('missing exception details are explicit, and Gateway errors keep their identity', async () => {
  const { browser } = fixture();
  browser.raw = async () => ({ exceptionDetails: {} });
  await assert.rejects(browser.observe({}), /浏览器未提供具体的脚本异常信息/);
  const stopped = Object.assign(new Error('User owns browser'), { code: 'AGENT_USER_IN_CONTROL' });
  browser.raw = async () => { throw stopped; };
  await assert.rejects(browser.observe({}), error => error === stopped);
});

function hoverFixture(svgDropdown = false) {
  const cursor = (value = 'auto') => ({ cursor: value, visibility: 'visible', display: 'block', opacity: '1' });
  const parent = { style: cursor(), textContent: '', closest: () => null };
  const node = (tag, style = cursor('pointer')) => ({
    tagName: tag, style, isConnected: true, parentElement: parent,
    getBoundingClientRect: () => ({ x: 720, y: 20, left: 720, right: 760, top: 20, bottom: 60, width: 40, height: 40 }),
    getAttribute: () => null, querySelector: () => null, closest: () => null,
    scrollIntoView: () => {}, contains: other => false
  });
  const avatar = node(svgDropdown ? 'svg' : 'DIV', cursor(svgDropdown ? 'auto' : 'pointer'));
  if (svgDropdown) avatar.getAttribute = name => name === 'class' ? 'ant-dropdown-trigger' : null;
  const inheritedIcon = { ...node('IMG'), parentElement: avatar };
  const decoration = node('IMG', cursor());
  const hiddenIcon = node('SPAN', { ...cursor('pointer'), visibility: 'hidden' });
  const link = { ...node('A'), innerText: '投递记录', href: 'https://fixture.test/applications' };
  let menuVisible = false, covered = false;
  const body = { innerText: '招聘首页' };
  const context = vm.createContext({ location: { href: 'https://fixture.test/' }, innerWidth: 800, innerHeight: 600,
    getComputedStyle: el => el.style,
    document: { title: '招聘首页', body, querySelectorAll: selector => selector === 'div,span,img,svg,li'
      ? [avatar, ...(svgDropdown ? [] : [inheritedIcon]), decoration, hiddenIcon]
      : [...(svgDropdown && selector.includes('[class*="dropdown-trigger"]') ? [avatar] : []), ...(menuVisible ? [link] : [])],
      elementFromPoint: () => covered ? decoration : avatar }
  });
  context.window = context;
  const mouse = [];
  const browser = new FastBrowser(async () => {}, async (_task, method, params) => {
    if (method === 'Runtime.evaluate') {
      try { return { result: { value: vm.runInContext(params.expression, context) } }; }
      catch (error) { return { exceptionDetails: { text: error.message } }; }
    }
    if (method === 'Input.dispatchMouseEvent') {
      mouse.push(params);
      if (params.type === 'mouseMoved') { menuVisible = true; body.innerText += '\n投递记录'; }
      return {};
    }
    throw Error(`Unexpected browser method: ${method}`);
  });
  return { browser, context, mouse, cover: () => { covered = true; } };
}

test('nonsemantic pointer avatar is observable and hover reveals its menu without clicking', async () => {
  const f = hoverFixture();
  const task = { observation: await f.browser.observe({}) };
  assert.equal(task.observation.fast.candidates.length, 1, 'ignore inherited, decorative and hidden icons');
  const avatar = task.observation.fast.candidates[0];
  assert.match(avatar.label, /上方右侧/);
  await f.browser.execute(task, { kind: 'hover', ref: avatar.ref, effect: 'read' });
  assert.deepEqual(f.mouse.map(e => [e.type, e.button]), [['mouseMoved', 'none']]);
  assert.ok((await f.browser.observe(task)).fast.candidates.some(c => c.label === '投递记录'));
});

test('hover preserves stale-page and occlusion checks without dispatching input', async () => {
  for (const reason of ['navigation', 'covered']) {
    const f = hoverFixture();
    const task = { observation: await f.browser.observe({}) };
    if (reason === 'navigation') f.context.location.href = 'https://fixture.test/changed';
    else f.cover();
    await assert.rejects(f.browser.execute(task, { kind: 'hover', ref: task.observation.fast.candidates[0].ref, effect: 'read' }),
      reason === 'navigation' ? /页面内容已经变化/ : /遮挡/);
    assert.equal(f.mouse.length, 0);
  }
});

test('a dropdown SVG without pointer cursor, role or tabindex is observable and can be hovered', async () => {
  const f = hoverFixture(true);
  const task = { observation: await f.browser.observe({}) };
  assert.equal(task.observation.fast.candidates.length, 1);
  const avatar = task.observation.fast.candidates[0];
  assert.match(avatar.label, /上方右侧/);
  await f.browser.execute(task, { kind: 'hover', ref: avatar.ref, effect: 'read' });
  assert.deepEqual(f.mouse.map(e => e.type), ['mouseMoved']);
  assert.ok((await f.browser.observe(task)).fast.candidates.some(c => c.label === '投递记录'));
});

function scrollFixture(horizontal = false, shadow = false) {
  const f = hoverFixture(), context = f.context;
  const target = context.document.querySelectorAll('div,span,img,svg,li')[0];
  context.scrollX = 0; context.scrollY = 0;
  context.document.documentElement = { scrollHeight: 5000, scrollWidth: 3000, style: { direction: 'ltr' } };
  let windowScrolls = 0;
  context.scrollBy = ({ top, left }) => { windowScrolls++; context.scrollY += top; context.scrollX += left; };
  const panel = { isConnected: true, textContent: 'Panel', style: { cursor: 'auto', overflowX: horizontal ? 'auto' : 'visible', overflowY: horizontal ? 'visible' : 'auto', direction: 'ltr' },
    scrollTop: 0, scrollLeft: 0, clientWidth: 200, clientHeight: 200, scrollWidth: horizontal ? 1200 : 200, scrollHeight: horizontal ? 200 : 1200,
    parentElement: context.document.body, closest: () => null,
    scrollBy({ top, left }) { this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + top)); this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left)); }
  };
  if (shadow) { target.parentElement = null; target.getRootNode = () => ({ host: panel }); }
  else target.parentElement = panel;
  return { ...f, target, panel, windowScrolls: () => windowScrolls };
}

const scrollResult = message => JSON.parse(message.match(/^滚动结果：(.*)；需要/)[1]);

test('ref scroll targets the nearest scroll container and reports movement and boundary without bubbling', async () => {
  const f = scrollFixture(), task = { observation: await f.browser.observe({}) }, ref = task.observation.fast.candidates[0].ref;
  const first = scrollResult(await f.browser.execute(task, { kind: 'scroll', ref, value: 'down' }));
  assert.equal(first.target, 'element'); assert.deepEqual(first.moved, { x: 0, y: 600 }); assert.equal(first.atBoundary, false);
  const second = scrollResult(await f.browser.execute(task, { kind: 'scroll', ref, value: 'down' }));
  assert.deepEqual(second.moved, { x: 0, y: 400 }); assert.equal(second.atBoundary, true);
  const third = scrollResult(await f.browser.execute(task, { kind: 'scroll', ref, value: 'down' }));
  assert.deepEqual(third.moved, { x: 0, y: 0 }); assert.equal(third.atBoundary, true);
  assert.equal(f.windowScrolls(), 0); assert.equal(f.context.scrollY, 0);
});

test('horizontal ref scrolling crosses a shadow host and rejects missing refs before moving the window', async () => {
  const f = scrollFixture(true, true), task = { observation: await f.browser.observe({}) }, ref = task.observation.fast.candidates[0].ref;
  const result = scrollResult(await f.browser.execute(task, { kind: 'scroll', ref, value: 'right' }));
  assert.deepEqual(result.moved, { x: 600, y: 0 }); assert.equal(f.panel.scrollLeft, 600);
  await assert.rejects(f.browser.execute(task, { kind: 'scroll', ref: 'e99999', value: 'down' }), /目标元素已失效/);
  assert.equal(f.windowScrolls(), 0);
});

test('an explicitly referenced scrollable control takes precedence over its scrollable parent', async () => {
  const f = scrollFixture();
  Object.assign(f.target, { scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 100, scrollWidth: 100, scrollHeight: 400, scrollBy: f.panel.scrollBy });
  f.target.style = { ...f.target.style, overflowY: 'auto', direction: 'ltr' };
  const task = { observation: await f.browser.observe({}) }, ref = task.observation.fast.candidates[0].ref;
  const result = scrollResult(await f.browser.execute(task, { kind: 'scroll', ref, value: 'down' }));
  assert.deepEqual(result.moved, { x: 0, y: 300 }); assert.equal(result.atBoundary, true);
  assert.equal(f.target.scrollTop, 300); assert.equal(f.panel.scrollTop, 0); assert.equal(f.windowScrolls(), 0);
});

test('ref without a scrollable target reports failure and unscoped scroll reports actual window displacement', async () => {
  const f = scrollFixture(), task = { observation: await f.browser.observe({}) }, ref = task.observation.fast.candidates[0].ref;
  f.panel.style.overflowY = 'visible';
  f.context.document.documentElement.scrollHeight = 600;
  await assert.rejects(f.browser.execute(task, { kind: 'scroll', ref, value: 'down' }), /没有可滚动区域/);
  assert.equal(f.windowScrolls(), 0);
  f.context.document.documentElement.scrollHeight = 5000;
  const result = scrollResult(await f.browser.execute(task, { kind: 'scroll', value: 'down' }));
  assert.equal(result.target, 'window'); assert.deepEqual(result.moved, { x: 0, y: 600 }); assert.equal(result.atBoundary, false);
});
