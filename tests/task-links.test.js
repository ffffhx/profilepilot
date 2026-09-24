const test = require("node:test");
const assert = require("node:assert/strict");
const { renderTaskText, openTaskLink } = require("../dist/renderer/task-links");
const { taskLinkUrl } = require("../dist/shared/task-link");
const { taskResultMessage } = require("../dist/renderer/task-history");
const { renderTaskEvents } = require("../dist/renderer/task-events");

test("chat links include localhost, queries and balanced brackets without prose punctuation", () => {
  const result = renderTaskText('地址：http://localhost:8080/（已运行）。 https://example.com/?a=1&b=2，(https://example.com/Foo_(bar)).');
  assert.match(result, /href="http:\/\/localhost:8080\/"/);
  assert.match(result, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.match(result, /href="https:\/\/example.com\/Foo_\(bar\)"/);
  assert.match(result, /<\/a>（已运行）。/);
  assert.match(result, /<\/a>\)\.$/);
  assert.equal(taskLinkUrl("http://[::1]:8080/"), "http://[::1]:8080/");
});

test("message HTML stays escaped and non-web or credential URLs cannot be opened", () => {
  const rendered = renderTaskText('<img src=x onerror="alert(1)"> javascript:alert(1) https://user:secret@example.com/');
  assert.doesNotMatch(rendered, /<img|<a /);
  assert.match(rendered, /&lt;img/);
  for (const value of [null, {}, "javascript:alert(1)", "file:///C:/test.html", "data:text/html,test", "ms-settings:test", "https://user:pass@example.com", "https://example.com\n", "https://example.com\\other", "http://"]) assert.equal(taskLinkUrl(value), null);
});

test("stored task results and progress both linkify without changing their text", () => {
  const summary = "网站：http://localhost:8080/";
  const task = { status: "completed", result: { summary, evidence: ["https://example.com/proof"], remaining: [] } };
  assert.equal((taskResultMessage(task, "已完成").match(/data-task-link/g) || []).length, 2);
  assert.match(renderTaskEvents([{ id: "message", kind: "assistant", text: summary, at: new Date().toISOString() }]), /data-task-link/);
  assert.equal(task.result.summary, summary);
});

test("click and middle click open externally, prevent navigation, and surface failures", async () => {
  const opened = [], failures = [];
  for (const type of ["click", "auxclick"]) {
    let prevented = false;
    const event = { type, button: type === "click" ? 0 : 1, target: { closest: () => ({ href: "http://localhost:8080/" }) }, preventDefault: () => { prevented = true; } };
    assert.equal(openTaskLink(event, async url => { opened.push(url); }, message => failures.push(message)), true);
    assert.equal(prevented, true);
  }
  assert.deepEqual(opened, ["http://localhost:8080/", "http://localhost:8080/"]);
  const event = { type: "click", target: { closest: () => ({ href: "http://localhost:8080/" }) }, preventDefault() {} };
  openTaskLink(event, async () => { throw new Error("browser unavailable"); }, message => failures.push(message));
  await Promise.resolve();
  assert.match(failures[0], /browser unavailable/);
});
