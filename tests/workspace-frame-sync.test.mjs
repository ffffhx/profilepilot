import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const { loadTsModule } = require("./helpers/load-ts-module.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function publicUrl(file) {
  return pathToFileURL(path.join(repoRoot, "public", file)).href;
}

function createWorkspaceFrameHarness(workspaceFile = "tasks.html", owned = true) {
  const { workspaceRoute } = loadTsModule("src/shared/workspaces.ts");
  const { REVIEW_METHODS } = loadTsModule("src/shared/review.ts");
  const listeners = new Map();
  const docEvents = [];
  const classes = new Set();
  let unsubscribeCount = 0;

  const makeChannel = () => {
    const handlers = new Set();
    return {
      subscribe(fn) {
        handlers.add(fn);
        return () => {
          unsubscribeCount += 1;
          handlers.delete(fn);
        };
      },
      emit(...args) {
        for (const fn of [...handlers]) fn(...args);
      }
    };
  };

  const taskChanged = makeChannel();
  const taskPreview = makeChannel();
  const profileState = makeChannel();

  const parent = {
    location: { href: publicUrl("workspace.html") },
    workspaceHost: { owns: () => owned, navigate: () => false },
    desktopWindow: { platform: "win32" },
    appUpdate: { status: async () => ({}), open: async () => {} },
    profileManager: { onStateChanged: (fn) => profileState.subscribe(fn) },
    browserConnection: {},
    tasks: {
      onChanged: (fn) => taskChanged.subscribe(fn),
      onPreview: (fn) => taskPreview.subscribe(fn),
      list: async () => ({ revision: 0, tasks: [] }),
      detail: async () => ({ id: "", version: 1 })
    },
    localApps: {},
    phones: {},
    mobile: {},
    desktopControl: {},
    gpuiControl: {}
  };

  const windowObj = {
    parent,
    addEventListener(name, fn) {
      listeners.set(name, fn);
    }
  };
  const documentObj = {
    hidden: false,
    documentElement: {
      classList: {
        add(...names) {
          for (const n of names) classes.add(n);
        },
        contains(name) {
          return classes.has(name);
        }
      },
      dataset: {}
    },
    dispatchEvent(event) {
      docEvents.push(event.type);
      return true;
    },
    addEventListener() {}
  };

  const source = transformSync(
    fs.readFileSync(path.join(repoRoot, "src/renderer/workspace-frame.ts"), "utf8"),
    { loader: "ts", format: "cjs", target: "es2022" }
  ).code;

  vm.runInNewContext(source, {
    window: windowObj,
    document: documentObj,
    location: { href: workspaceFile.startsWith("file:") ? workspaceFile : publicUrl(workspaceFile) },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    require(specifier) {
      if (specifier.endsWith("workspaces")) return { workspaceRoute };
      if (specifier.endsWith("review")) return { REVIEW_METHODS };
      return {};
    }
  });

  return {
    window: windowObj,
    document: documentObj,
    classes,
    docEvents,
    taskChanged,
    taskPreview,
    profileState,
    get unsubscribeCount() {
      return unsubscribeCount;
    }
  };
}

function makeTaskSummary(id, status = "running") {
  return {
    id,
    title: `Task ${id}`,
    profileId: "isolated:p1",
    profileName: "P1",
    status,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z"
  };
}

test("inactive agent pane queues sequential tasks.onChanged revisions without dropping intermediate deltas", async () => {
  const { TaskData } = loadTsModule("src/renderer/task-data.ts");
  const harness = createWorkspaceFrameHarness("tasks.html");

  let currentRevision = 5;
  let listCalls = 0;
  let currentTasks = [makeTaskSummary("t1", "queued")];

  const data = new TaskData(
    {
      list: async () => {
        listCalls += 1;
        return {
          revision: currentRevision,
          tasks: [...currentTasks],
          schedules: [],
          templates: [],
          materials: [],
          settings: { model: "sonnet", hasApiKey: false, jevEnabled: false, jevHasApiKey: false, jevProvider: "claude", jevMode: "advisory" }
        };
      },
      detail: async () => ({ id: "t1", version: 1 }),
      onChanged: harness.window.tasks.onChanged
    },
    () => {}
  );

  harness.window.workspacePane.setActive(true);
  await data.refresh();
  assert.equal(listCalls, 1);
  assert.equal(data.list.revision, 5);

  harness.window.workspacePane.setActive(false);

  const updates = [
    { revision: 6, tasks: [makeTaskSummary("t1", "running")], removed: [] },
    { revision: 7, tasks: [makeTaskSummary("t2", "queued")], removed: [] },
    { revision: 8, tasks: [makeTaskSummary("t1", "completed")], removed: [] },
    { revision: 9, tasks: [], removed: ["t2"] }
  ];
  currentRevision = 9;
  currentTasks = [makeTaskSummary("t1", "completed")];
  for (const update of updates) {
    harness.taskChanged.emit(update);
  }

  // Hidden pane has not yet applied updates.
  assert.equal(data.list.revision, 5);

  harness.window.workspacePane.setActive(true);

  // All 4 deltas replayed sequentially in-memory with zero full list() resyncs!
  assert.equal(data.list.revision, 9);
  assert.deepEqual(
    data.list.tasks.map((t) => [t.id, t.status]),
    [["t1", "completed"]]
  );
  assert.equal(listCalls, 1, "sequential replay must not trigger redundant list() resync");

  data.dispose();
  harness.window.workspacePane.dispose();
});

test("inactive pane bounds revision queue at 128 and replays latest on overflow for clean single resync", async () => {
  const { TaskData } = loadTsModule("src/renderer/task-data.ts");
  const harness = createWorkspaceFrameHarness("tasks.html");

  let serverRevision = 1;
  let listCalls = 0;

  const data = new TaskData(
    {
      list: async () => {
        listCalls += 1;
        return {
          revision: serverRevision,
          tasks: [makeTaskSummary(`t-${serverRevision}`, "running")],
          schedules: [],
          templates: [],
          materials: [],
          settings: { model: "sonnet", hasApiKey: false, jevEnabled: false, jevHasApiKey: false, jevProvider: "claude", jevMode: "advisory" }
        };
      },
      detail: async () => ({ id: "t1", version: 1 }),
      onChanged: harness.window.tasks.onChanged
    },
    () => {}
  );

  const receivedRevisions = [];
  harness.window.tasks.onChanged((update) => receivedRevisions.push(update.revision));

  harness.window.workspacePane.setActive(true);
  await data.refresh();
  assert.equal(listCalls, 1);

  harness.window.workspacePane.setActive(false);
  for (let rev = 2; rev <= 150; rev += 1) {
    serverRevision = rev;
    harness.taskChanged.emit({ revision: rev, tasks: [makeTaskSummary(`t-${rev}`, "running")], removed: [] });
  }

  assert.deepEqual(receivedRevisions, []);
  harness.window.workspacePane.setActive(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(receivedRevisions, [150], "overflowed queue collapses to latest revision");
  assert.equal(listCalls, 2, "TaskData performs a single clean resync on overflow");
  assert.equal(data.list.revision, 150);

  data.dispose();
  harness.window.workspacePane.dispose();
});

test("inactive pane defers and coalesces tasks.onPreview frames until activated", () => {
  const harness = createWorkspaceFrameHarness("tasks.html");
  const seenFrames = [];

  harness.window.tasks.onPreview((update) => {
    seenFrames.push(update.frameId);
    harness.docEvents.push(`preview:${update.frameId}`);
  });

  harness.taskPreview.emit({ taskId: "t1", state: "live", message: "frame 1", frame: "AAA", frameId: 1 });
  harness.taskPreview.emit({ taskId: "t1", state: "live", message: "frame 2", frame: "BBB", frameId: 2 });
  harness.taskPreview.emit({ taskId: "t1", state: "live", message: "frame 3", frame: "CCC", frameId: 3 });

  assert.deepEqual(seenFrames, [], "hidden pane must not decode or paint intermediate preview frames");

  harness.window.workspacePane.setActive(true);
  assert.deepEqual(seenFrames, [3], "only latest preview frame is delivered upon activation");
  assert.deepEqual(harness.docEvents.slice(-2), ["preview:3", "workspace-visibilitychange"]);
});

test("experimental feature flags default Agent to true and game-follow / screen-camera to false", () => {
  const storage = new Map();
  const listeners = new Map();
  const dispatched = [];
  const origLocalStorage = globalThis.localStorage;
  const origWindow = globalThis.window;

  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, val) => storage.set(key, String(val))
  };
  globalThis.window = {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    dispatchEvent: (ev) => {
      dispatched.push(ev.type);
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return true;
    }
  };

  try {
    const features = loadTsModule("src/renderer/experimental-features.ts");
    assert.equal(features.experimentalAgentEnabled(), true, "Agent tab is enabled by default");
    assert.equal(features.experimentalWorkspaceEnabled("agent"), true);
    assert.equal(features.experimentalGameFollowEnabled(), false);
    assert.equal(features.experimentalScreenCameraEnabled(), false);

    let notified = 0;
    features.onExperimentalFeaturesChanged(() => {
      notified += 1;
    });

    features.setExperimentalAgentEnabled(false);
    assert.equal(features.experimentalAgentEnabled(), false);
    assert.equal(features.experimentalWorkspaceEnabled("agent"), false);

    features.setExperimentalGameFollowEnabled(true);
    assert.equal(features.experimentalGameFollowEnabled(), true);

    features.setExperimentalScreenCameraEnabled(true);
    assert.equal(features.experimentalScreenCameraEnabled(), true);
    assert.equal(notified, 3);

    for (const fn of listeners.get("storage") || []) {
      fn({ key: "profilepilot-experimental-game-follow" });
      fn({ key: "profilepilot-experimental-screen-camera" });
      fn({ key: "unrelated-key" });
    }
    assert.equal(notified, 5, "storage events for game-follow and screen-camera notify listeners");
  } finally {
    globalThis.localStorage = origLocalStorage;
    globalThis.window = origWindow;
  }
});

test("mini-document mode, strict CSP headers, and hidden-workspace settings polling guard are configured", () => {
  const miniHarness = createWorkspaceFrameHarness(`${publicUrl("index.html")}?mode=mini`, false);
  assert.equal(miniHarness.classes.has("mini-document"), true);

  for (const file of ["index.html", "tools.html", "settings.html"]) {
    const html = fs.readFileSync(path.join(repoRoot, "public", file), "utf8");
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /script-src 'self'/);
    assert.match(html, /img-src 'self' data:/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} must not contain inline scripts`);
  }

  const settingsSource = fs.readFileSync(path.join(repoRoot, "src/renderer/settings.ts"), "utf8");
  assert.match(settingsSource, /!document\.hidden\s*&&\s*!workspaceHidden\(\)/);
  assert.match(settingsSource, /队友跟随（实验性）/);
  assert.match(settingsSource, /屏幕摄像头（实验性）/);
});
