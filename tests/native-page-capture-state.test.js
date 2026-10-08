require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NativePage } = require('../src/main/tasks/native-page.ts');

// Run the production serialized expressions. Observers deliberately do not
// cross document/shadow boundaries; a screenshot advances only one rAF.
function captureFixture() {
  const f = { calls: [], frames: new Map(), pngs: 0, nextContext: 1, announced: new Set(),
    task: { profileId: 'native:capture-test', sessionId: 'capture-test' } };
  const rootNode = () => ({ elements: [], querySelectorAll() { return this.elements; } });
  const world = frame => {
    const observers = new Set(), raf = new Map(), timers = new Set(); let nextRaf = 0;
    const document = { ...rootNode(), documentElement: { scrollWidth: 800, scrollHeight: 600 }, getAnimations: () => [] };
    const context = vm.createContext({ document, location: { href: frame.url }, performance: { timeOrigin: frame.contextId },
      innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, visualViewport: { scale: 1 },
      MutationObserver: class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); this.records = []; observers.add(this); }
        observe(target) { this.targets.add(target); }
        disconnect() { this.targets.clear(); this.records = []; }
        takeRecords() { const records = this.records; this.records = []; return records; }
      },
      requestAnimationFrame: callback => { const id = ++nextRaf; raf.set(id, callback); return id; },
      cancelAnimationFrame: id => raf.delete(id),
      setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); timers.add(timer); return timer; },
      clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); }
    });
    context.window = context;
    return { context, document, text: `${frame.id}:before`,
      mutate(target, text = `${frame.id}:after`) {
        this.text = text;
        for (const observer of observers) if (observer.targets.has(target)) observer.records.push({ type: 'characterData', target });
      },
      attachShadow(parent = document) {
        const root = rootNode(); parent.elements.push({ shadowRoot: root }); return root;
      },
      pulse() { const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(callback => callback(Date.now())); },
      dispose() { timers.forEach(clearTimeout); raf.clear(); }
    };
  };
  f.addFrame = (id, session) => {
    const frame = { id, parentId: id === 'root' ? undefined : 'root', session,
      url: `https://${id}.fixture.test/`, loaderId: `${id}-loader`, contextId: f.nextContext++ };
    frame.world = world(frame); f.frames.set(id, frame); return frame;
  };
  f.addFrame('root');
  f.pixels = () => JSON.stringify([...f.frames.values()].map(frame => [frame.id, frame.world.text]));
  const info = ({ id, parentId, url, loaderId }) => ({ id, parentId, url, loaderId });
  f.page = new NativePage(async (_task, method, params = {}, session) => {
    f.calls.push({ method, params, session });
    if (method === 'Page.enable') return {};
    if (method === 'Target.setAutoAttach') {
      if (!session) for (const frame of f.frames.values()) if (frame.session && !f.announced.has(frame.session)) {
        f.announced.add(frame.session);
        f.page.event({ type: 'cdp', profileId: f.task.profileId, sessionId: f.task.sessionId,
          method: 'Target.attachedToTarget', params: { sessionId: frame.session, targetInfo: { type: 'iframe' } } });
      }
      return {};
    }
    if (method === 'Page.getFrameTree') {
      const root = session ? [...f.frames.values()].find(frame => frame.session === session) : f.frames.get('root');
      assert.ok(root, `unknown debugger session ${session}`);
      return { frameTree: { frame: info(root), childFrames: session ? [] : [...f.frames.values()].filter(frame => frame.parentId === 'root').map(frame => ({ frame: info(frame) })) } };
    }
    if (method === 'Page.createIsolatedWorld') {
      const frame = f.frames.get(params.frameId); assert.equal(session, frame.session);
      return { executionContextId: frame.contextId };
    }
    if (method === 'Runtime.evaluate') {
      const frame = params.contextId === undefined ? f.frames.get('root') : [...f.frames.values()].find(frame => frame.contextId === params.contextId);
      assert.ok(frame, `unknown execution context ${params.contextId}`); assert.equal(session, frame.session);
      assert.notEqual(params.awaitPromise, true, 'the owned extension queue must remain free to pulse a frame');
      try { return { result: { value: vm.runInContext(params.expression, frame.world.context) } }; }
      catch (error) { return { exceptionDetails: { text: error.message } }; }
    }
    if (method === 'Page.captureScreenshot') {
      assert.equal(session, undefined, 'the composed image is captured through the root target');
      const data = Buffer.from(f.pixels()).toString('base64');
      if (params.format === 'png') { f.pngs++; await f.onPng?.(f.pngs); }
      for (const frame of f.frames.values()) frame.world.pulse();
      return { data };
    }
    throw Error(`Unexpected CDP method ${method}`);
  });
  f.navigate = id => {
    const frame = f.frames.get(id); frame.world.dispose();
    frame.loaderId += '-navigated'; frame.contextId = f.nextContext++;
    frame.world = world(frame); frame.world.text = `${id}:navigated`;
  };
  f.removeFrame = id => {
    const frame = f.frames.get(id); frame.world.dispose(); f.frames.delete(id);
    if (frame.session) f.page.event({ type: 'cdp', profileId: f.task.profileId, sessionId: f.task.sessionId,
      method: 'Target.detachedFromTarget', params: { sessionId: frame.session } });
  };
  f.dispose = () => { for (const frame of f.frames.values()) frame.world.dispose(); };
  return f;
}

async function acceptedImage(f) {
  const result = await f.page.captureScreenshot(f.task);
  assert.equal(Buffer.from(result.result.data, 'base64').toString(), f.pixels(), 'the returned image must match the final document content/topology');
  return result;
}

test('unchanged root, same-process iframe and OOPIF pass with their own context and debugger session', async t => {
  const f = captureFixture(); t.after(f.dispose);
  const child = f.addFrame('child'), oopif = f.addFrame('oopif', 'child-session');
  await acceptedImage(f); assert.equal(f.pngs, 1);
  const reads = f.calls.filter(call => call.params.expression?.includes('profilepilot-capture-state'));
  assert.deepEqual(reads.map(call => [call.params.contextId, call.session]),
    [[child.contextId, undefined], [oopif.contextId, 'child-session'], [1, undefined],
      [child.contextId, undefined], [oopif.contextId, 'child-session'], [1, undefined]]);
});

test('an existing nested open shadow mutation invalidates the first image without a light DOM mutation', async t => {
  const f = captureFixture(); t.after(f.dispose);
  const root = f.frames.get('root').world, shadow = root.attachShadow(), nested = root.attachShadow(shadow);
  f.onPng = count => { if (count === 1) root.mutate(nested); };
  await acceptedImage(f); assert.equal(f.pngs, 2);
  assert.equal(root.context.__profilepilot_capture_v2.roots.length, 3);
});

test('attaching a new open shadow root invalidates the first image even without a document observer record', async t => {
  const f = captureFixture(); t.after(f.dispose);
  const root = f.frames.get('root').world;
  f.onPng = count => { if (count === 1) { root.attachShadow(); root.text = 'root:new-shadow-content'; } };
  await acceptedImage(f); assert.equal(f.pngs, 2);
  assert.equal(root.context.__profilepilot_capture_v2.roots.length, 2);
});

test('same-process iframe and OOPIF document mutations invalidate a root screenshot independently', async t => {
  for (const session of [undefined, 'child-session']) await t.test(session ? 'OOPIF' : 'same-process', async t => {
    const f = captureFixture(); t.after(f.dispose); const child = f.addFrame('child', session);
    f.onPng = count => { if (count === 1) child.world.mutate(child.world.document); };
    await acceptedImage(f); assert.equal(f.pngs, 2);
    const reads = f.calls.filter(call => call.params.expression?.includes('profilepilot-capture-state') && call.params.contextId === child.contextId);
    assert.ok(reads.length >= 4); assert.ok(reads.every(call => call.session === session));
  });
});

test('same-URL iframe and OOPIF navigations invalidate the image and use the new isolated context', async t => {
  for (const session of [undefined, 'child-session']) await t.test(session ? 'OOPIF' : 'same-process', async t => {
    const f = captureFixture(); t.after(f.dispose); const child = f.addFrame('child', session), originalContext = child.contextId;
    f.onPng = count => { if (count === 1) f.navigate('child'); };
    await acceptedImage(f); assert.equal(f.pngs, 2); assert.notEqual(child.contextId, originalContext);
    const reads = f.calls.filter(call => call.params.expression?.includes('profilepilot-capture-state') && call.session === session);
    assert.ok(reads.some(call => call.params.contextId === originalContext));
    assert.ok(reads.some(call => call.params.contextId === child.contextId));
  });
});

test('iframe insertion and OOPIF removal invalidate the first image when root state is unchanged', async t => {
  for (const change of ['insert', 'remove-oopif']) await t.test(change, async t => {
    const f = captureFixture(); t.after(f.dispose);
    if (change === 'remove-oopif') f.addFrame('child', 'child-session');
    f.onPng = count => { if (count === 1) { if (change === 'insert') f.addFrame('child'); else f.removeFrame('child'); } };
    await acceptedImage(f); assert.equal(f.pngs, 2);
  });
});
