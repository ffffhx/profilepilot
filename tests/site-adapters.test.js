const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { listSiteAdapters, planSiteAdapter } = require('../dist/main/site-adapters/catalog');
const { readSitePage } = require('../dist/main/site-adapters/page');
const { runSiteAdapter } = require('../dist/main/site-adapters/runner');
const { prepareXiaohongshuSearch } = require('../dist/main/site-adapters/xiaohongshu-page');

async function page(operation, params, body, overrides = {}, access) {
  const plan = planSiteAdapter({ operation, params }), calls = [];
  plan.access = access;
  const document = { body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [] };
  // API/page-state tests only. HTML card selectors are covered in browser tests.
  class DOMParser { parseFromString(raw) { return { body: { textContent: String(raw).replace(/<[^>]*>/g, '').replaceAll('&amp;', '&') }, querySelectorAll: () => [] }; } }
  const context = { location: new URL(plan.url), document, window: {}, URL, URLSearchParams, DOMParser, AbortSignal, Date, setTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, url, text: async () => typeof body === 'function' ? body(url) : typeof body === 'string' ? body : JSON.stringify(body) }; }, ...overrides };
  const result = await vm.runInNewContext(`(${readSitePage.toString()})(${JSON.stringify(plan)})`, context);
  return { result: JSON.parse(JSON.stringify(result)), calls };
}

test('catalog exposes all 18 promised operations, schemas and explicit city; unknown filters fail closed', () => {
  const all = listSiteAdapters();
  assert.equal(all.length, 18); assert.equal(new Set(all.map(s => s.operation.split('.')[0])).size, 8);
  assert.deepEqual(all.reduce((a, d) => (a[d.batch] = (a[d.batch] || 0) + 1, a), {}), { 1: 7, 2: 6, 3: 5 });
  assert.ok(all.every(d => d.readOnly && d.input.type === 'object'));
  assert.throws(() => planSiteAdapter({ operation: 'boss.search', params: { query: '前端' } }));
  assert.throws(() => planSiteAdapter({ operation: 'zhihu.search', params: { query: 'hello', salary: 123 } }));
  assert.throws(() => planSiteAdapter({ operation: '__proto__' }));
});

test('detail URLs cannot escape site, carry credentials, choose ports or arbitrary paths', () => {
  for (const url of ['https://www.xiaohongshu.com.evil.test/explore/abc', 'https://user:pass@www.xiaohongshu.com/explore/abc', 'http://www.xiaohongshu.com/explore/abc', 'https://www.xiaohongshu.com:8443/explore/abc', 'https://www.xiaohongshu.com/logout']) {
    assert.throws(() => planSiteAdapter({ operation: 'xiaohongshu.detail', params: { url } }));
  }
  assert.throws(() => planSiteAdapter({ operation: 'wechat.article', params: { url: 'https://weixin.sogou.com/other' } }));
});

test('Zhihu preserves 19-digit identifiers and encodes query without changing string numbers', async () => {
  const { result, calls } = await page('zhihu.search', { query: 'AI & "1234567890123456789"', limit: 1 },
    '{"data":[{"type":"search_result","object":{"type":"answer","id":1234567890123456789,"question":{"id":2234567890123456789,"title":"A &amp; B"},"excerpt":"1234567890123456789"}}],"paging":{"is_end":false,"next":"https://www.zhihu.com/api/v4/search_v3?offset=7"}}');
  assert.equal(result.items[0].id, '1234567890123456789');
  assert.equal(result.items[0].url, 'https://www.zhihu.com/question/2234567890123456789/answer/1234567890123456789');
  assert.equal(result.pagination.next.offset, 7);
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'AI & "1234567890123456789"');
  assert.equal(calls[0].options.credentials, 'include');
});

test('hot list uses exact ID, rank and source; valid empty data differs from broken schema', async () => {
  const { result } = await page('zhihu.hot', {}, '{"data":[{"target":{"id":9223372036854775807,"title":"Test"},"detail_text":"100万热度"}]}');
  assert.equal(result.items[0].id, '9223372036854775807'); assert.equal(result.items[0].rank, 1);
  assert.equal((await page('zhihu.hot', {}, { data: [] })).result.status, 'empty');
  assert.equal((await page('zhihu.hot', {}, { error: 'changed' })).result.error.code, 'SCHEMA_CHANGED');
});

test('API rejection, HTTP denial, non-JSON and foreign navigation cannot masquerade as empty success', async () => {
  assert.equal((await page('boss.search', { query: 'QA', city: '101020100' }, { code: 37, message: 'blocked' })).result.status, 'blocked');
  assert.equal((await page('zhihu.hot', {}, '', { fetch: async () => ({ ok: false, status: 403 }) })).result.status, 'blocked');
  assert.equal((await page('zhihu.hot', {}, '<html>login</html>')).result.error.code, 'NOT_JSON');
  const other = await page('zhihu.hot', {}, { data: [] }, { location: new URL('https://evil.test/') });
  assert.equal(other.result.error.code, 'ORIGIN_MISMATCH'); assert.equal(other.calls.length, 0);
});

test('origin restrictions survive page redirects and reject API reads before fetching', async () => {
  const redirected = await page('wechat.article', { url: 'https://weixin.sogou.com/link?url=example' }, '',
    { location: new URL('https://mp.weixin.qq.com/s/example') }, { allowedOrigins: ['https://weixin.sogou.com'] });
  assert.equal(redirected.result.error.code, 'ACCESS_BLOCKED');
  assert.equal(redirected.calls.length, 0);
  const api = await page('bilibili.search', { query: 'test' }, {}, {}, { blockedOrigins: ['https://api.bilibili.com'] });
  assert.equal(api.result.error.code, 'ACCESS_BLOCKED');
  assert.equal(api.calls.length, 0);
  let bodyRead = false;
  const response = await page('zhihu.hot', {}, '', { fetch: async () => ({ ok: true, url: 'https://passport.zhihu.com/login',
    text: async () => { bodyRead = true; return ''; } }) });
  assert.equal(response.result.error.code, 'ACCESS_BLOCKED');
  assert.equal(bodyRead, false);
});

test('BOSS candidates omit full JD; detail verifies identity, carries job facts and rejects mismatches', async () => {
  const { result } = await page('boss.search', { query: 'QA', city: '101020100', limit: 1 }, { code: 0, zpData: { jobList: [{ encryptJobId: 'abc', securityId: 'opaque', jobName: 'QA', salaryDesc: '10-20K', brandName: 'Company' }], hasMore: true } });
  assert.equal(result.items[0].securityId, 'opaque'); assert.equal(result.items[0].description, undefined);
  assert.equal(result.pagination.next.page, 2);
  const detail = await page('boss.detail', { id: 'abc', securityId: 'opaque' }, { code: 0, zpData: { jobInfo: { encryptId: 'abc', jobName: 'QA', postDescription: 'Full JD' } } });
  assert.equal(detail.result.items[0].description, 'Full JD');
  assert.equal((await page('boss.detail', { id: 'abc', securityId: 'opaque' }, { code: 0, zpData: { jobInfo: { encryptId: 'other', postDescription: 'Wrong JD' } } })).result.error.code, 'RESULT_MISMATCH');
});

test('Bilibili reads true video results, preserves reply IDs and labels incomplete nested replies', async () => {
  const id = 'BV1ooDyBmE6v';
  const search = await page('bilibili.search', { query: 'test', limit: 2 }, { code: 0, data: { numPages: 2, result: [{ type: 'video', bvid: id, title: '<em>Test</em>' }, { type: 'ad', title: 'Advertisement' }] } });
  assert.equal(search.result.items.length, 1); assert.equal(search.result.items[0].title, 'Test');
  const body = url => JSON.stringify(url.includes('/view?') ? { code: 0, data: { bvid: id, aid: 10, title: 'Video' } } :
    { code: 0, data: { page: { count: 1 }, replies: [{ rpid_str: '9999999999999999999', parent: 0, content: { message: 'Comment' }, rcount: 2, replies: [] }] } });
  const detail = await page('bilibili.detail', { id }, body); assert.equal(detail.result.items[0].aid, '10');
  const comments = await page('bilibili.comments', { id }, body);
  assert.equal(comments.result.items[0].id, '9999999999999999999'); assert.equal(comments.result.status, 'partial');
  assert.equal(comments.result.pagination.hasMore, false);
});

test('Reddit preserves cursors and distinguishes omitted comment branches', async () => {
  const { result } = await page('reddit.search', { query: 'test', subreddit: 'programming' }, { data: { children: [{ kind: 't3', data: { id: 'abc', title: 'Post', permalink: '/r/programming/comments/abc/' } }], after: 't3_next' } });
  assert.equal(result.pagination.next.cursor, 't3_next'); assert.equal(result.items[0].url, 'https://www.reddit.com/r/programming/comments/abc/');
  const thread = await page('reddit.thread', { id: 'abc', depth: 1 }, [{ data: { children: [{ data: { id: 'abc', title: 'Post', num_comments: 8 } }] } },
    { data: { children: [{ kind: 't1', data: { name: 't1_a', parent_id: 't3_abc', body: 'A', replies: { data: { children: [{ kind: 't1', data: { name: 't1_b', body: 'B' } }] } } } }, { kind: 'more', data: { count: 6 } }] } }]);
  assert.equal(thread.result.status, 'partial'); assert.equal(thread.result.items[0].returnedComments, 1);
  assert.equal(thread.result.items[0].omittedCommentsAtLeast, 7); assert.equal(thread.result.items[0].comments[0].parentId, 't3_abc');
});

test('Xiaohongshu reads page store, retains note context and marks loaded-only candidates', async () => {
  const id = '1234567890abcdef12345678', url = `https://www.xiaohongshu.com/explore/${id}?xsec_token=opaque`;
  const window = { __INITIAL_STATE__: { search: { feeds: { _value: [{ id, xsecToken: 'opaque', noteCard: { displayTitle: 'Note', user: { nickname: 'Author' } } }] } },
    note: { noteDetailMap: { [id]: { note: { title: 'Note', desc: 'Body' }, comments: { list: [{ id: 'reply', content: 'Comment', subComments: [] }] } } } } } };
  const search = await page('xiaohongshu.search', { query: 'hello' }, {}, { window });
  assert.equal(search.result.status, 'partial'); assert.equal(new URL(search.result.items[0].url).searchParams.get('xsec_token'), 'opaque');
  assert.equal((await page('xiaohongshu.detail', { url }, {}, { window })).result.items[0].text, 'Body');
  assert.equal((await page('xiaohongshu.comments', { url }, {}, { window })).result.items[0].text, 'Comment');
});

test('Xiaohongshu rejects stale or still-loading results and verifies native sorting', async () => {
  const search = { searchContext: { keyword: 'hello', sort: 'time_descending' }, state: 'success',
    filterParams: [{ type: 'sort_type', tags: ['general'] }], feeds: [{ id: '1234567890abcdef12345678', noteCard: { displayTitle: 'Old card' } }] };
  const window = { __INITIAL_STATE__: { search } };
  assert.equal((await page('xiaohongshu.search', { query: 'hello', sort: 'latest' }, {}, { window })).result.error.code, 'SORT_UNVERIFIED');
  search.filterParams[0].tags = ['time_descending']; search.state = 'loading';
  assert.equal((await page('xiaohongshu.search', { query: 'hello', sort: 'latest' }, {}, { window })).result.error.code, 'NOT_READY');
  search.state = 'success'; search.searchContext.keyword = 'previous';
  assert.equal((await page('xiaohongshu.search', { query: 'hello', sort: 'latest' }, {}, { window })).result.error.code, 'NOT_READY');
  search.searchContext.keyword = 'hello';
  const result = (await page('xiaohongshu.search', { query: 'hello', sort: 'latest' }, {}, { window })).result;
  assert.equal(result.effective.sortVerified, true); assert.equal(result.items[0].title, 'Old card');
});

test('Xiaohongshu preserves missing titles, zero likes and ranks; only confirmed empty searches are empty', async () => {
  const search = { state: 'success', hasMore: false, feeds: [
    { id: '1234567890abcdef12345678', noteCard: { type: 'video', interactInfo: { likedCount: 0 } } },
    { id: '2234567890abcdef12345678', noteCard: { title: 'Title fallback' } }
  ] };
  const window = { __INITIAL_STATE__: { search } };
  const result = (await page('xiaohongshu.search', { query: 'hello' }, {}, { window })).result;
  assert.equal(result.items[0].title, null); assert.equal(result.items[0].titleStatus, 'missing');
  assert.equal(result.items[0].likes, 0); assert.equal(result.items[1].title, 'Title fallback'); assert.equal(result.items[1].rank, 2);
  search.feeds = [];
  assert.equal((await page('xiaohongshu.search', { query: 'hello' }, {}, { window })).result.status, 'empty');
  search.state = 'loading';
  assert.equal((await page('xiaohongshu.search', { query: 'hello' }, {}, { window })).result.error.code, 'NOT_READY');
});

test('Xiaohongshu route uses the current app input and router without replacing network functions', async () => {
  const calls = [], fetch = () => assert.fail('must use page navigation, not a new fetch');
  const search = { mutateSearchValue: q => calls.push(['input', q]), $onAction: () => () => {} };
  const globals = { $pinia: { _s: new Map([['search', search]]) },
    $router: { push: route => { calls.push(['route', route.query.keyword]); return Promise.resolve(); } } };
  const plan = planSiteAdapter({ operation: 'xiaohongshu.search', params: { query: 'new & search' } });
  const context = { location: new URL('https://www.xiaohongshu.com/search_result?keyword=old'), URL, Promise, fetch, setTimeout: () => 1, clearTimeout: () => {},
    document: { querySelector: () => ({ __vue_app__: { config: { globalProperties: globals } } }) } };
  const result = vm.runInNewContext(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},"route")`, context);
  assert.equal(result.state, 'performed'); assert.deepEqual(calls, [['input', 'new & search'], ['route', 'new & search']]);
  assert.equal(context.fetch, fetch);
  calls.length = 0; delete search.$onAction;
  assert.equal(vm.runInNewContext(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},"route")`, context).state, 'unavailable');
  assert.equal(calls.length, 0); // Fall back to navigation when completion cannot be observed.
  calls.length = 0; context.location = new URL(plan.url + '&type=51');
  assert.equal(vm.runInNewContext(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},"route")`, context).state, 'ready');
  assert.equal(calls.length, 0);
  plan.access = { blockedOrigins: ['https://www.xiaohongshu.com'] };
  assert.throws(() => vm.runInNewContext(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},"route")`, context), /限制/);
  assert.equal(calls.length, 0);
});

test('Xiaohongshu sorting only clicks the verified native sort control', () => {
  let clicks = 0;
  const button = { textContent: '最新', getBoundingClientRect: () => ({ width: 30 }), click: () => clicks++ };
  const panel = { querySelectorAll: () => [{ querySelectorAll: () => [{}, button] }] };
  const filter = { querySelector: () => panel, dispatchEvent: () => {} };
  const store = { state: 'success', searchContext: { keyword: 'hello' }, filterParams: [{ type: 'sort_type', tags: ['general'] }],
    filters: [{ id: 'sort_type', filterTags: [{ id: 'general', name: '综合' }, { id: 'time_descending', name: '最新' }] }] };
  const globals = { $pinia: { _s: new Map([['search', store]]) } };
  const plan = planSiteAdapter({ operation: 'xiaohongshu.search', params: { query: 'hello', sort: 'latest' } });
  const context = { location: new URL(plan.url), MouseEvent: class {}, document: { querySelector: selector => selector === '#app' ? { __vue_app__: { config: { globalProperties: globals } } } : filter } };
  const run = () => vm.runInNewContext(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},"sort")`, context);
  button.textContent = '别的操作'; assert.equal(run().state, 'unavailable'); assert.equal(clicks, 0);
  button.textContent = '最新'; assert.equal(run().state, 'performed'); assert.equal(clicks, 1);
  store.filterParams[0].tags = ['time_descending']; assert.equal(run().state, 'ready'); assert.equal(clicks, 1);
});

test('Xiaohongshu waits for the actual route search to finish before accepting existing cards', () => {
  let callback, completed, timedOut, unsubscribed = false;
  const search = { state: 'success', searchContext: { keyword: 'old' }, feeds: [{ title: 'stale card' }],
    filterParams: [{ type: 'sort_type', tags: ['general'] }], mutateSearchValue: () => {},
    $onAction: fn => { callback = fn; return () => { unsubscribed = true; }; } };
  const globals = { $pinia: { _s: new Map([['search', search]]) }, $router: { push: () => Promise.resolve() } };
  const plan = planSiteAdapter({ operation: 'xiaohongshu.search', params: { query: 'new' } });
  const context = vm.createContext({ URL, Promise, location: new URL('https://www.xiaohongshu.com/search_result?keyword=old'),
    setTimeout: fn => { timedOut = fn; return 1; }, clearTimeout: () => {}, document: { querySelector: () => ({ __vue_app__: { config: { globalProperties: globals } } }) } });
  const run = stage => vm.runInContext(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},${JSON.stringify(stage)})`, context);
  assert.equal(run('route').state, 'performed');
  assert.equal(search.searchContext.keyword, 'new');
  assert.equal(run('sort').state, 'waiting'); // Old cards + new keyword are insufficient.
  callback({ name: 'fetchNotePageData', after: fn => { completed = fn; }, onError: () => {} });
  completed();
  assert.equal(run('sort').state, 'ready'); assert.equal(unsubscribed, true);
  run('route'); timedOut();
  assert.throws(() => run('sort'), /加载失败/);
});

test('YouTube excludes secondary recommendations and returns actual caption timing with range cursor', async () => {
  const id = 'SPM1tm2ZdK4', video = { videoRenderer: { videoId: id, title: { runs: [{ text: 'Video' }] } } };
  const window = { ytInitialData: { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [video] } }, secondaryContents: { videoRenderer: { videoId: 'wrong' } } } } },
    ytInitialPlayerResponse: { videoDetails: { videoId: id, title: 'Video' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=test' }] } } } };
  const search = await page('youtube.search', { query: 'hello' }, {}, { window });
  assert.equal(search.result.items.length, 1); assert.equal(search.result.items[0].id, id);
  assert.equal((await page('youtube.detail', { id }, {}, { window })).result.items[0].title, 'Video');
  const transcript = await page('youtube.transcript', { id, limit: 1 }, { events: [{ tStartMs: 123, dDurationMs: 456, segs: [{ utf8: 'Hello' }] }, { tStartMs: 700, segs: [{ utf8: 'World' }] }] }, { window });
  assert.equal(transcript.result.items[0].startMs, 123); assert.equal(transcript.result.items[0].durationMs, 456); assert.equal(transcript.result.pagination.next.offset, 1);
  assert.equal((await page('youtube.transcript', { id, language: 'ja' }, {}, { window })).result.error.code, 'CAPTIONS_UNAVAILABLE');
});

test('runner cancels on ownership change and does not retry failed transport or HTTP', async () => {
  let calls = 0, control = true;
  await assert.rejects(runSiteAdapter({ operation: 'zhihu.hot' }, { check: () => { if (!control) throw Error('takeover'); },
    evaluate: async () => { calls++; control = false; return { url: 'https://www.zhihu.com/hot', ready: 'complete' }; }, open: async () => assert.fail() }), /takeover/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(runSiteAdapter({ operation: 'zhihu.hot' }, { evaluate: async () => { calls++; throw Error('unknown outcome'); }, open: async () => assert.fail() }), /unknown outcome/);
  assert.equal(calls, 1);
  const failure = { version: 1, operation: 'zhihu.hot', status: 'blocked', items: [], error: { code: 'ACCESS_BLOCKED' } };
  calls = 0;
  const result = await runSiteAdapter({ operation: 'zhihu.hot' }, { evaluate: async () => ++calls < 3 ? { url: 'https://www.zhihu.com/hot', ready: 'complete' } : failure, open: async () => assert.fail() });
  assert.equal(result.status, 'blocked'); assert.equal(calls, 3);
});
