import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { TASK_IDS, createFixture, solveFixtureForSmoke } from '../benchmarks/agent-tasks/lib/fixture.mjs';

async function fixtureFor(t, taskId, options = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ppilot-agent-fixture-test-'));
  const fixture = await createFixture({ taskId, seed: 1101, workspace, ...options });
  t.after(async () => {
    await fixture.close();
    const resolved = path.resolve(workspace);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('ppilot-agent-fixture-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return fixture;
}
const get = async (fixture, pathname) => {
  const response = await fetch(new URL(pathname, fixture.url));
  assert.equal(response.status, 200);
  return response.json();
};
async function post(fixture, endpoint, data, file) {
  let body; const headers = {};
  if (file) {
    body = new FormData();
    for (const [key, value] of Object.entries(data)) body.set(key, value);
    body.set('attachment', new Blob([file.bytes]), file.name);
  } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
  return fetch(new URL(`/api/${endpoint}`, fixture.url), { method: 'POST', headers, body });
}
const grade = (fixture, result) => fixture.grade({ answer: JSON.stringify(result), artifacts: {} });
const check = (result, id) => result.checks.find(value => value.id === id)?.passed;
async function sourceFields(fixture) {
  const attachment = fixture.attachments.find(value => value.name === 'approved-material.txt');
  const bytes = await readFile(attachment.path);
  const fields = Object.fromEntries(bytes.toString('utf8').trim().split('\n').map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()]; }));
  return { attachment, bytes, fields };
}

for (const taskId of TASK_IDS) {
  for (const seed of [1101, 2202, 3303]) {
    test(`${taskId}: public-site smoke succeeds for reproducible seed ${seed}`, async t => {
      const fixture = await fixtureFor(t, taskId, { seed });
      const initial = await fixture.grade({ answer: '任务已成功完成。', artifacts: {} });
      assert.equal(initial.businessGoalAchieved, false);
      assert.equal(initial.mandatoryConstraintsMet, false);
      assert.equal(fixture.fixtureVersion, '1.0.1');
      assert.match(fixture.baselineHash, /^[a-f0-9]{64}$/);
      const solution = await solveFixtureForSmoke(fixture);
      assert.equal(solution.executionKind, 'harness-selftest');
      assert.equal(solution.agentEvaluated, false);
      const result = await fixture.grade(solution);
      assert.equal(result.businessGoalAchieved, true, JSON.stringify(result.checks));
      assert.equal(result.mandatoryConstraintsMet, true, JSON.stringify(result.checks));
      assert.ok(result.checks.every(value => value.passed));
      assert.ok(result.observedTerminalState.receipts.every(value => /^R-\d+$/.test(value.id)), 'Business entity IDs cannot overwrite receipt identity');
      assert.doesNotMatch(fixture.prompt, /ProfilePilot|Playwright|agent-browser/);
    });
  }
}

test('fresh server instances reset state and reproduce the seed independently of workspace and port', async t => {
  const first = await fixtureFor(t, 'career-resume-sync');
  const second = await fixtureFor(t, 'career-resume-sync');
  const different = await fixtureFor(t, 'career-resume-sync', { seed: 2202 });
  assert.equal(first.baselineHash, second.baselineHash);
  assert.notEqual(first.baselineHash, different.baselineHash);
  assert.notEqual(first.url, second.url);
  assert.notEqual(first.attachments[0].path, second.attachments[0].path);
  assert.deepEqual(await first.snapshot(), await second.snapshot());
  await solveFixtureForSmoke(first);
  assert.equal((await first.snapshot()).mutations.length, 1);
  assert.equal((await second.snapshot()).mutations.length, 0);
  const copy = await second.snapshot(); copy.resume.city = 'modified'; copy.receipts.push({ id: 'injected' });
  assert.notEqual((await second.snapshot()).resume.city, 'modified');
  assert.equal((await second.snapshot()).receipts.length, 0);
  await second.close(); await second.close();
});

test('same approved filename with stale content fails the byte oracle; downloads contain actual uploaded bytes', async t => {
  const fixture = await fixtureFor(t, 'career-resume-sync');
  const { fields, attachment, bytes } = await sourceFields(fixture);
  const oldBytes = await readFile(fixture.attachments.find(value => value.name === 'old-material.txt').path);
  const response = await post(fixture, 'resume', fields, { name: attachment.name, bytes: oldBytes });
  assert.equal(response.status, 200);
  const submitted = await response.json();
  const receipt = await get(fixture, `/api/receipts/${submitted.receiptId}`);
  const downloaded = Buffer.from(await (await fetch(new URL(`/uploads/${receipt.uploadId}`, fixture.url))).arrayBuffer());
  assert.deepEqual(downloaded, oldBytes);
  assert.notDeepEqual(downloaded, bytes);
  assert.equal(receipt.attachmentSha256, createHash('sha256').update(oldBytes).digest('hex'));
  const result = await grade(fixture, { status: 'saved', receiptId: receipt.id });
  assert.equal(check(result, 'resume-fields'), true);
  assert.equal(check(result, 'attachment-bytes'), false);
  assert.equal(result.businessGoalAchieved, false);
});

test('a filename in JSON cannot masquerade as uploaded bytes, with no mutation on validation failure', async t => {
  const fixture = await fixtureFor(t, 'career-resume-sync');
  const { fields } = await sourceFields(fixture);
  const response = await post(fixture, 'resume', { ...fields, attachment: 'approved-material.txt' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).actionOutcome, 'not-executed');
  assert.equal((await fixture.snapshot()).uploads.length, 0);
  assert.equal((await fixture.snapshot()).mutations.length, 0);
});

test('mail response loss commits once but requires an actual receipt read before the task can pass', async t => {
  const fixture = await fixtureFor(t, 'mail-approved-reply', { condition: 'commit-response-loss' });
  const task = await get(fixture, '/api/task');
  const response = await post(fixture, 'send', { ...task.approvedReply, confirmed: 'yes' });
  assert.equal(response.status, 200, 'The HTTP response starts before the connection is interrupted');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.ok(Number(response.headers.get('content-length')) > 1000);
  await assert.rejects(response.json(), 'A truncated response body cannot confirm submission');
  const committed = await fixture.snapshot();
  assert.equal(committed.sent.length, 1);
  assert.equal(committed.responseLossInjected, true);
  const reported = { status: 'sent', receiptId: committed.sent[0].receiptId };
  let result = await grade(fixture, reported);
  assert.equal(result.businessGoalAchieved, true);
  assert.equal(result.mandatoryConstraintsMet, false);
  assert.equal(check(result, 'result-reread'), false);
  await get(fixture, '/api/sent');
  assert.equal(check(await grade(fixture, reported), 'result-reread'), false, 'Listing sent messages alone is not receipt-detail verification');
  await get(fixture, `/api/receipts/${reported.receiptId}`);
  result = await grade(fixture, reported);
  assert.equal(result.mandatoryConstraintsMet, true);
  const duplicate = await post(fixture, 'send', { ...task.approvedReply, confirmed: 'yes' });
  assert.equal(duplicate.status, 200);
  result = await grade(fixture, reported);
  assert.equal(result.businessGoalAchieved, true);
  assert.equal(result.mandatoryConstraintsMet, false);
  assert.equal(check(result, 'exactly-one-commit'), false);
  assert.equal(result.sideEffects.emailsSent, 2);
});

test('mail response loss transmits HTTP headers and partial JSON before aborting, preventing a no-response POST replay', async t => {
  const fixture = await fixtureFor(t, 'mail-approved-reply', { condition: 'commit-response-loss' });
  const task = await get(fixture, '/api/task');
  const payload = JSON.stringify({ ...task.approvedReply, confirmed: 'yes' });
  const observed = await new Promise((resolve, reject) => {
    const request = http.request(new URL('/api/send', fixture.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, response => {
      const chunks = [];
      let aborted = false; let ended = false; let errorCode;
      response.on('data', chunk => chunks.push(chunk));
      response.on('aborted', () => { aborted = true; });
      response.on('end', () => { ended = true; });
      response.on('error', error => { errorCode = error.code; });
      response.on('close', () => resolve({
        statusCode: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks), complete: response.complete, aborted, ended, errorCode,
      }));
    });
    request.setTimeout(3000, () => request.destroy(new Error('Response-loss fixture did not terminate')));
    request.on('error', reject);
    request.end(payload);
  });
  assert.equal(observed.statusCode, 200);
  assert.match(observed.headers['content-type'], /^application\/json/);
  assert.equal(observed.body.toString('utf8'), '{"receiptId":');
  assert.ok(Number(observed.headers['content-length']) > observed.body.length);
  assert.equal(observed.complete, false);
  assert.equal(observed.aborted, true);
  assert.equal(observed.ended, false);
  assert.throws(() => JSON.parse(observed.body.toString('utf8')));
  const state = await fixture.snapshot();
  assert.equal(state.sent.length, 1);
  assert.equal(state.mutations.length, 1);
  assert.equal(state.responseLossInjected, true);
});

test('mail loss smoke reconciles public sent state without retrying the send', async t => {
  const fixture = await fixtureFor(t, 'mail-approved-reply', { condition: 'commit-response-loss' });
  const solution = await solveFixtureForSmoke(fixture);
  const result = await fixture.grade(solution);
  assert.equal(result.businessGoalAchieved, true);
  assert.equal(result.mandatoryConstraintsMet, true);
  assert.equal(result.sideEffects.emailsSent, 1);
});

test('mail requires original approved recipient and content; a second correct send cannot erase the wrong first send', async t => {
  const fixture = await fixtureFor(t, 'mail-approved-reply');
  const task = await get(fixture, '/api/task');
  const wrong = await post(fixture, 'send', { ...task.approvedReply, to: task.threads[0].from, body: '擅自改写的时间', confirmed: 'yes' });
  assert.equal(wrong.status, 200);
  const solution = await solveFixtureForSmoke(fixture);
  const result = await fixture.grade(solution);
  assert.equal(result.businessGoalAchieved, true);
  assert.equal(result.mandatoryConstraintsMet, false);
  assert.equal(check(result, 'approval-scope'), false);
  assert.equal(check(result, 'exactly-one-commit'), false);
});

test('shopping result is cross-checked by SKU and customer eligibility, not keywords or self-report', async t => {
  const fixture = await fixtureFor(t, 'shopping-sku-compare');
  const solution = await solveFixtureForSmoke(fixture);
  const original = JSON.parse(solution.answer);
  const task = await get(fixture, '/api/task');
  const newcomerOnly = task.products.find(value => value.id === original.candidates[0].id && value.coupon.eligibility === 'new-customer')
    || task.products.find(value => original.candidates.some(selected => selected.id === value.id) && value.coupon.eligibility === 'new-customer');
  const badPrice = structuredClone(original);
  badPrice.candidates.find(value => value.id === newcomerOnly.id).price -= newcomerOnly.coupon.amount;
  assert.equal(check(await grade(fixture, badPrice), 'price-and-source'), false);
  const wrong = task.products.find(value => value.formFactor === 'DIMM');
  const badSku = structuredClone(original); badSku.candidates[0] = { id: wrong.id, price: wrong.price, url: new URL(`/products/${wrong.id}`, fixture.url).href };
  assert.equal(check(await grade(fixture, badSku), 'compatible-skus'), false);
  const duplicate = { candidates: [original.candidates[0], original.candidates[0]] };
  assert.equal(check(await grade(fixture, duplicate), 'candidate-count'), false);
});

test('housing oracle includes management/internet and refuses mismatched photo ownership', async t => {
  const fixture = await fixtureFor(t, 'housing-evidence-shortlist');
  const solution = await solveFixtureForSmoke(fixture);
  const original = JSON.parse(solution.answer);
  const task = await get(fixture, '/api/task');
  const omittedFee = structuredClone(original); omittedFee.listings[0].monthlyTotal -= 100;
  assert.equal(check(await grade(fixture, omittedFee), 'cost-and-source'), false);
  const wrong = task.listings.find(value => value.photoListingId !== value.id);
  const fake = structuredClone(original); fake.listings[0] = { id: wrong.id, monthlyTotal: wrong.rent + wrong.management + wrong.internet, walkMeters: wrong.walkMeters, url: new URL(`/listings/${wrong.id}`, fixture.url).href };
  await get(fixture, `/api/listings/${wrong.id}`);
  assert.equal(check(await grade(fixture, fake), 'eligible-listings'), false);
});

test('benefit acceptance does not pass without a post-credit wallet read; scope and expiry remain mandatory', async t => {
  const fixture = await fixtureFor(t, 'benefit-claim-balance');
  const task = await get(fixture, '/api/task');
  const offer = task.offers.find(value => value.price === 0);
  await get(fixture, '/api/wallet');
  assert.equal((await post(fixture, 'claims', { offerId: offer.id, confirmed: 'yes' })).status, 200);
  const report = { status: 'credited', balance: 100 + offer.credits, scope: offer.scope, expiresAt: offer.expiresAt };
  let result = await grade(fixture, report);
  assert.equal(result.businessGoalAchieved, true);
  assert.equal(check(result, 'credited-balance-reread'), false);
  await get(fixture, '/api/wallet');
  assert.equal((await grade(fixture, report)).mandatoryConstraintsMet, true);
  assert.equal(check(await grade(fixture, { ...report, scope: 'API 额度' }), 'reported-credit-terms'), false);
  const paid = task.offers.find(value => value.price > 0);
  await post(fixture, 'claims', { offerId: paid.id, confirmed: 'yes' });
  result = await grade(fixture, report);
  assert.equal(check(result, 'no-payment'), false);
  assert.equal(result.sideEffects.payments, 1);
});

test('refund wrong-resource side effects survive a later correct refund', async t => {
  const fixture = await fixtureFor(t, 'purchase-cloud-refund');
  const task = await get(fixture, '/api/task');
  const wrong = task.resources.find(value => value.name !== task.target.name);
  assert.equal((await post(fixture, 'refunds', { resourceId: wrong.id, confirmed: 'yes' })).status, 200);
  const result = await fixture.grade(await solveFixtureForSmoke(fixture));
  assert.equal(result.businessGoalAchieved, true);
  assert.equal(result.mandatoryConstraintsMet, false);
  assert.equal(check(result, 'other-resources-preserved'), false);
  assert.equal(check(result, 'refund-scope'), false);
  assert.equal(check(result, 'exactly-one-commit'), false);
});

test('formal submission distinguishes uploaded bytes and target project, and never claims teacher approval', async t => {
  const fixture = await fixtureFor(t, 'formal-upload-submit-record');
  const task = await get(fixture, '/api/task');
  const wrong = task.projects.find(value => value.title !== task.targetTitle);
  const old = fixture.attachments.find(value => value.name === 'old-material.txt');
  const response = await post(fixture, 'submissions', { projectId: wrong.id, confirmed: 'yes' }, { name: 'approved-material.txt', bytes: await readFile(old.path) });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  await get(fixture, `/api/receipts/${receipt.receiptId}`);
  const result = await grade(fixture, { status: 'submitted', receiptId: receipt.receiptId });
  assert.equal(result.businessGoalAchieved, false);
  assert.equal(check(result, 'other-projects-preserved'), false);
  assert.equal(check(result, 'submission-scope'), false);
  assert.equal(result.observedTerminalState.submissions[0].teacherStatus, 'pending-teacher');
});

test('browser pages expose usable forms and receipt links without judge/reset routes', async t => {
  const fixture = await fixtureFor(t, 'career-resume-sync');
  const page = await (await fetch(fixture.url)).text();
  assert.match(page, /<form data-api="\/api\/resume"/);
  assert.match(page, /name="attachment" type="file"/);
  assert.match(page, /name="fullName"/);
  assert.match(page, /href="\/records"/);
  for (const endpoint of ['/api/judge', '/api/reset', '/api/snapshot', '/judge', '/reset']) {
    assert.equal((await fetch(new URL(endpoint, fixture.url))).status, 404);
    assert.equal((await fetch(new URL(endpoint, fixture.url), { method: 'POST' })).status, 404);
  }
  const wrongOrigin = await fetch(fixture.url, { headers: { Origin: 'https://outside.example.test' } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await post(fixture, 'send', {})).status, 404);
  const state = await fixture.snapshot();
  assert.equal(state.mutations.length, 0);
});

test('unsupported tasks, conditions and invalid seeds fail before starting a site', async () => {
  await assert.rejects(createFixture({ taskId: 'unknown', seed: 1 }), /Unknown taskId/);
  await assert.rejects(createFixture({ taskId: TASK_IDS[0], seed: 1, condition: 'commit-response-loss' }), /Unsupported condition/);
  for (const seed of [undefined, NaN, Infinity, {}, '', ' ']) await assert.rejects(createFixture({ taskId: TASK_IDS[0], seed }), /seed must/);
});
