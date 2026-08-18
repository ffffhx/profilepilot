const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const test = require("node:test");

const {
  executeProfilePilotManagementCommand,
  startProfilePilotManagementServer
} = require("../dist/main/profilepilot-management-server.js");
const {
  createDoctorReport,
  parseProfilePilotCliArgs,
  requestProfilePilotManagement
} = require("../dist/main/profilepilot-cli.js");

test("management commands provide safe CRUD for ProfilePilot-owned Profiles", async () => {
  const manager = fakeProfileManager();

  const listed = await executeProfilePilotManagementCommand({ action: "profile.list" }, { profileManager: manager });
  assert.deepEqual(listed.profiles.map((profile) => [profile.name, profile.manageable]), [
    ["系统默认 Profile", false],
    ["朋友试用", true]
  ]);

  const created = await executeProfilePilotManagementCommand(
    { action: "profile.create", name: "PPE 验证" },
    { profileManager: manager }
  );
  assert.equal(created.profile.name, "PPE 验证");
  assert.equal(created.profile.manageable, true);

  const id = created.profile.id;
  const renamed = await executeProfilePilotManagementCommand(
    { action: "profile.rename", selector: id, name: "PPE 回归" },
    { profileManager: manager }
  );
  assert.equal(renamed.profile.name, "PPE 回归");

  const started = await executeProfilePilotManagementCommand(
    { action: "profile.start", selector: id },
    { profileManager: manager }
  );
  assert.equal(started.changed, true);
  assert.equal(started.profile.running, true);
  const startedAgain = await executeProfilePilotManagementCommand(
    { action: "profile.start", selector: id },
    { profileManager: manager }
  );
  assert.equal(startedAgain.changed, false);

  const stopped = await executeProfilePilotManagementCommand(
    { action: "profile.stop", selector: id },
    { profileManager: manager }
  );
  assert.equal(stopped.profile.running, false);

  await assert.rejects(
    () => executeProfilePilotManagementCommand(
      { action: "profile.delete", selector: id, confirmed: false },
      { profileManager: manager }
    ),
    (error) => error.code === "PROFILE_DELETE_CONFIRMATION_REQUIRED"
  );
  const deleted = await executeProfilePilotManagementCommand(
    { action: "profile.delete", selector: id, confirmed: true },
    { profileManager: manager }
  );
  assert.equal(deleted.deleted_profile.id, id);
  assert.equal(deleted.recoverable, true);

  await assert.rejects(
    () => executeProfilePilotManagementCommand(
      { action: "profile.rename", selector: "native:Default", name: "Nope" },
      { profileManager: manager }
    ),
    (error) => error.code === "PROFILE_CLI_MANAGED_ONLY"
  );
});

test("management server authenticates a local CLI request and cleans up its socket", async () => {
  // macOS limits Unix-domain socket paths to roughly 100 bytes; keep the fixture root short.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-"));
  const home = path.join(root, "home");
  const managementRoot = path.join(root, "control");
  const env = { ...process.env, PROFILEPILOT_MANAGEMENT_ROOT: managementRoot };
  fs.mkdirSync(home, { recursive: true });
  const handle = await startProfilePilotManagementServer({
    profileManager: fakeProfileManager(),
    homeDir: home,
    env,
    appVersion: "test-version"
  });
  try {
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(handle.socketPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(managementRoot, "secret")).mode & 0o777, 0o600);
    }
    const unauthorized = await rawManagementRequest(handle.socketPath, {
      version: 1,
      id: "unauthorized",
      token: "0".repeat(64),
      command: { action: "ping" }
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error.code, "MANAGEMENT_UNAUTHORIZED");
    const response = await requestProfilePilotManagement({ action: "ping" }, home, env);
    assert.equal(response.ok, true);
    assert.equal(response.data.app_version, "test-version");
    assert.equal(response.data.protocol_version, 1);
  } finally {
    await handle.close();
    if (process.platform !== "win32") assert.equal(fs.existsSync(handle.socketPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI parser exposes stable profile management commands and explicit delete confirmation", () => {
  assert.deepEqual(parseProfilePilotCliArgs(["profile", "list", "--json"]), {
    json: true,
    command: { action: "profile.list" }
  });
  assert.deepEqual(parseProfilePilotCliArgs(["profile", "create", "--name", "PPE 验证", "--json"]), {
    json: true,
    command: { action: "profile.create", name: "PPE 验证" }
  });
  assert.deepEqual(parseProfilePilotCliArgs(["profile", "delete", "isolated:one"]), {
    json: false,
    command: { action: "profile.delete", selector: "isolated:one", confirmed: false }
  });
  assert.equal(
    parseProfilePilotCliArgs(["profile", "delete", "isolated:one", "--yes"]).command.confirmed,
    true
  );
  assert.throws(() => parseProfilePilotCliArgs(["profile", "rename", "only-one-value"]), /rename 需要/);
  const before = Date.now() - 2 * 60 * 60 * 1000;
  const logs = parseProfilePilotCliArgs(["logs", "--level", "error", "--since", "2h", "--limit", "50", "--json"]);
  const after = Date.now() - 2 * 60 * 60 * 1000;
  assert.equal(logs.local, "logs");
  assert.equal(logs.json, true);
  assert.deepEqual(logs.levels, ["error"]);
  assert.ok(logs.since >= before && logs.since <= after);
  assert.equal(logs.limit, 50);
  assert.equal(logs.follow, false);
  assert.deepEqual(parseProfilePilotCliArgs(["doctor", "--json"]), { local: "doctor", json: true });
  assert.throws(() => parseProfilePilotCliArgs(["logs", "--level", "fatal"]), /--level/);
});

test("doctor reports an offline app together with local diagnostic state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-doctor-"));
  const home = path.join(root, "home");
  const env = {
    ...process.env,
    PROFILEPILOT_MANAGEMENT_ROOT: path.join(root, "missing-management"),
    PROFILEPILOT_LOG_ROOT: path.join(root, "logs")
  };
  fs.mkdirSync(home, { recursive: true });
  try {
    const report = await createDoctorReport(home, env);
    assert.equal(report.status, "warning");
    assert.equal(report.app.running, false);
    assert.match(report.app.error, /未运行/);
    assert.equal(report.logs.recent_errors, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeProfileManager() {
  let next = 1;
  let profiles = [
    fakeProfile({ id: "native:Default", name: "系统默认 Profile", source: "native", dirName: "Default" }),
    fakeProfile({ id: "isolated:friend", name: "朋友试用", source: "isolated", dirName: "friend" })
  ];
  const state = () => ({ profiles });
  return {
    async getState() {
      return state();
    },
    async createProfile(name) {
      const id = `created-${next++}`;
      const dirName = `created-${id}`;
      profiles.push(fakeProfile({ id: `isolated:${id}`, name, source: "isolated", dirName }));
      return { id, name, dirName, createdAt: new Date().toISOString(), lastLaunchedAt: null };
    },
    async renameProfile(id, name) {
      profiles = profiles.map((profile) => profile.id === id ? { ...profile, name } : profile);
    },
    async launchProfile(id) {
      profiles = profiles.map((profile) => profile.id === id ? { ...profile, running: true } : profile);
    },
    async closeProfile(id) {
      profiles = profiles.map((profile) => profile.id === id ? { ...profile, running: false } : profile);
    },
    async deleteProfile(id) {
      const deletedProfile = profiles.find((profile) => profile.id === id);
      profiles = profiles.filter((profile) => profile.id !== id);
      return { deletedProfile, trashPath: `/Trash/${deletedProfile.dirName}`, state: state() };
    }
  };
}

function rawManagementRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline !== -1) {
        socket.destroy();
        resolve(JSON.parse(output.slice(0, newline)));
      }
    });
  });
}

function fakeProfile(input) {
  return {
    ...input,
    running: false,
    cdpPort: null,
    fixedCdpPort: null,
    bifrostProxy: null,
    upstreamProxy: null,
    directConnection: false,
    projectTag: null,
    agentAccessDisabled: false,
    agentBrowserOccupancy: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    lastLaunchedAt: null
  };
}
