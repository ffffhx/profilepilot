const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { buildAgentOverlayPayload } = require("../dist/main/agent-overlay.js");
const { agentOverlayBootstrapScript } = require("../dist/main/overlay-script.js");

test("AgentOverlay payload keeps known fields stable and nulls empty values", () => {
  const payload = buildAgentOverlayPayload({
    locale: "zh",
    state: "active",
    profileName: "Work Profile",
    now: Date.parse("2026-07-08T12:00:00.000Z"),
    clients: [{ pid: 3201, label: "Codex" }]
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    "agent",
    "currentAction",
    "currentStep",
    "lastMessage",
    "locale",
    "nextStep",
    "profileName",
    "project",
    "session",
    "sessionTitle",
    "sessions",
    "startedAt",
    "state",
    "todoDone",
    "todoTotal",
    "updatedAt"
  ].sort());
  assert.equal(payload.locale, "zh");
  assert.equal(payload.agent, "Codex");
  assert.equal(payload.project, null);
  assert.equal(payload.session, null);
  assert.equal(payload.sessionTitle, null);
  assert.equal(payload.currentAction, "AI 正在操作浏览器");
  assert.equal(payload.currentStep, null);
  assert.equal(payload.nextStep, null);
  assert.equal(payload.todoDone, null);
  assert.equal(payload.todoTotal, null);
  assert.equal(payload.lastMessage, null);
  assert.equal(payload.startedAt, null);
  assert.equal(payload.updatedAt, "2026-07-08T12:00:00.000Z");

  assert.equal(payload.sessions.length, 1);
  assert.deepEqual(payload.sessions[0], {
    agent: "Codex",
    project: null,
    session: null,
    sessionTitle: null,
    lastActive: null,
    startedAt: null
  });

  const serialized = JSON.stringify(payload);
  assert.match(serialized, /"currentStep":null/);
  assert.match(serialized, /"lastMessage":null/);
});

test("AgentOverlay payload chooses latest lastActive primary and orders sessions", () => {
  const payload = buildAgentOverlayPayload({
    state: "active",
    profileName: "Work Profile",
    clients: [
      {
        pid: 300,
        label: "Claude Code",
        project: "old-project",
        title: "Older Claude",
        session: "cc-old",
        lastActive: "2026-07-08T10:00:00.000Z"
      },
      {
        pid: 900,
        label: "Codex",
        project: "direct-codex",
        title: "Direct Codex"
      },
      {
        pid: 100,
        label: "agent-browser",
        project: "new-project",
        title: "Newer Codex",
        session: "cx-new",
        lastActive: "2026-07-08T12:00:00.000Z"
      },
      {
        pid: 50,
        label: "agent-browser",
        project: "tie-project",
        title: "Tie Breaker",
        session: "cx-tie",
        lastActive: "2026-07-08T12:00:00.000Z"
      }
    ]
  });

  assert.equal(payload.agent, "Codex");
  assert.equal(payload.project, "tie-project");
  assert.equal(payload.session, "cx-tie");
  assert.deepEqual(payload.sessions.map((session) => session.project), [
    "tie-project",
    "new-project",
    "old-project",
    "direct-codex"
  ]);
  assert.equal(payload.sessions.length, 4);
  assert.equal(payload.sessions[3].agent, "Codex");
  assert.equal(payload.sessions[3].session, null);
});

test("agent overlay bootstrap update resets known fields instead of merging stale values", () => {
  const script = agentOverlayBootstrapScript();
  assert.match(script, /KNOWN_STATE_FIELDS/);
  assert.match(script, /normalizeKnownStateValue/);
  assert.match(script, /value === null \|\| value === undefined/);
  assert.doesNotMatch(script, /Object\.assign\(state,\s*payload\)/);
  new vm.Script(script);
});
