const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadUtil() {
  return loadTsModule("src/renderer/util.ts", {
    stubs: {
      "src/renderer/state.ts": {
        dateFormatter: {
          format(date) {
            return `formatted:${date.toISOString()}`;
          }
        },
        store: { busyState: null }
      }
    }
  });
}

test("renderer escapeHtml escapes XSS-sensitive characters and keeps safe text", () => {
  const { escapeHtml } = loadUtil();

  assert.equal(escapeHtml("<>&\"'中文"), "&lt;&gt;&amp;&quot;&#039;中文");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(null), "");
});

test("renderer truncateText adds ellipsis only past the boundary", () => {
  const { truncateText } = loadUtil();

  assert.equal(truncateText("abcdef", 4), "abc…");
  assert.equal(truncateText("abcd", 4), "abcd");
  assert.equal(truncateText("🙂🙂🙂", 3), "🙂…");
  assert.equal(truncateText("你好世界", 3), "你好…");
});

test("renderer date helpers handle empty, invalid, and relative times", () => {
  const { formatDate, formatRelativeTime } = loadUtil();
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-08T12:00:00.000Z");

  try {
    assert.equal(formatDate(null), "从未");
    assert.equal(formatDate("not-a-date"), "未知");
    assert.equal(formatDate("2026-07-08T10:00:00.000Z"), "formatted:2026-07-08T10:00:00.000Z");

    assert.equal(formatRelativeTime(null), "");
    assert.equal(formatRelativeTime("not-a-date"), "");
    assert.equal(formatRelativeTime("2026-07-08T11:59:30.000Z"), "刚刚");
    assert.equal(formatRelativeTime("2026-07-08T11:45:00.000Z"), "15分钟前");
    assert.equal(formatRelativeTime("2026-07-08T09:00:00.000Z"), "3小时前");
    assert.equal(formatRelativeTime("2026-07-05T12:00:00.000Z"), "3天前");
  } finally {
    Date.now = realNow;
  }
});

test("renderer agent activity text picks the clearest lead, progress, and tooltip", () => {
  const { agentActivityLeadText, agentActivityProgressText, agentActivityTooltipText } = loadUtil();

  assert.equal(
    agentActivityLeadText({
      currentAction: "  Inspecting\n  page  ",
      currentStep: "Fallback step",
      lastMessage: "Fallback message"
    }),
    "Inspecting page"
  );
  assert.equal(agentActivityLeadText({ currentStep: "  Reading   DOM " }), "Reading DOM");
  assert.equal(agentActivityLeadText({ lastMessage: "Only message" }), "Only message");
  assert.equal(agentActivityLeadText(null), "");

  assert.equal(agentActivityProgressText({ todoDone: 2.8, todoTotal: 5.2 }), "2/5");
  assert.equal(agentActivityProgressText({ todoDone: 3 }), "3");
  assert.equal(agentActivityProgressText({ todoTotal: 4 }), "0/4");
  assert.equal(agentActivityProgressText({ todoDone: -1, todoTotal: 0 }), "");

  assert.equal(
    agentActivityTooltipText(
      {
        currentAction: "Click save",
        currentStep: "Review form",
        nextStep: "Submit",
        todoDone: 1,
        todoTotal: 3,
        lastMessage: "abcdefghijklmnopqrstuvwxyz"
      },
      10
    ),
    ["当前动作：Click save", "进度：第 1/3 步", "当前步骤：Review form", "下一步：Submit", "AI 最近说：abcdefghi…"].join("\n")
  );
});

test("renderer CDP client text summarizes sessions and tools", () => {
  const { cdpClientToolSummary, cdpSessionText } = loadUtil();

  assert.equal(cdpSessionText({ pid: 1, label: "agent-browser", project: "profilepilot", title: "Fix tests" }), "profilepilot · Fix tests");
  assert.equal(cdpSessionText({ pid: 2, label: "agent-browser", title: "Untitled" }), "Untitled");

  assert.equal(
    cdpClientToolSummary([
      { pid: 1, label: "agent-browser-darwin-arm64" },
      { pid: 2, label: "Claude Code", agent: "Claude Code" },
      { pid: 3, label: "agent-browser" },
      { pid: 4, label: "chrome-devtools.exe" }
    ]),
    "agent-browser ×2、Claude Code、chrome-devtools"
  );
});

test("renderer exposes lease occupancy when Gateway has no active owner", () => {
  const {
    agentBrowserOccupancyClient,
    profileAgentBrowserReserved,
    profileUserHasControl
  } = loadUtil();
  const profile = {
    gatewayControl: null,
    agentBrowserOccupancy: {
      cdpPort: 9224,
      profileId: "isolated:work",
      profileName: "工作 Profile",
      session: "cx-owner",
      ownership: "user",
      agent: "Codex",
      project: "buy-together",
      command: "snapshot",
      holderPid: 100,
      daemonPid: 200,
      updatedAt: "2026-07-11T05:25:39.358Z"
    }
  };

  assert.equal(profileAgentBrowserReserved(profile), true);
  assert.equal(profileUserHasControl(profile), true);
  assert.deepEqual(agentBrowserOccupancyClient(profile), {
    pid: 200,
    label: "agent-browser",
    agent: "Codex",
    project: "buy-together",
    title: "agent-browser snapshot",
    session: "cx-owner",
    lastActive: "2026-07-11T05:25:39.358Z",
    note: "Session 仍保留，浏览器控制权当前属于用户；自动候选不会使用此 Profile"
  });
});

test("renderer explains a Gateway handoff as pending user action", () => {
  const { gatewayControlClient } = loadUtil();
  const client = gatewayControlClient({
    gatewayControl: {
      publicPort: 9224,
      ownership: "user",
      sessionStatus: "active",
      agentHealth: "waiting",
      connectionActive: false,
      ownerSessionId: "cx-owner",
      daemonInstanceId: "daemon-owner",
      daemonPid: 200,
      agent: "Codex",
      project: "coze-test-account-cli",
      pendingUserAction: "手动加载未打包扩展",
      updatedAt: "2026-07-14T13:24:00.000Z"
    }
  });

  assert.equal(client.session, "cx-owner");
  assert.match(client.note, /等待用户操作“手动加载未打包扩展”/);
  assert.match(client.note, /Session 仍保留/);
});

test("renderer formatErrorMessage removes transport noise and preserves recovery copy", () => {
  const { formatErrorMessage } = loadUtil();

  assert.equal(
    formatErrorMessage(new Error("Error invoking remote method 'x': ProfileManagerError: Could not copy profile")),
    "Could not copy profile"
  );
  assert.equal(formatErrorMessage("  "), "操作失败，请稍后重试。");
  assert.equal(
    formatErrorMessage("Error: ENOENT: no such file or directory, open '.profilepilot-sync-123/tmp'"),
    "同步临时文件已被系统清理或上次任务中断，请重新点击同步，ProfilePilot 会先恢复临时状态再继续。"
  );
});
