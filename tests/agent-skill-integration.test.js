const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { agentSkillTargetPaths, bundledAgentSkillPath, inspectAgentSkill, inspectAgentSkills,
  inspectProfilePilotCliSkill, setAgentSkillEnabled } = require("../dist/main/agent-skill-integration.js");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-skill-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function marker(directory, skillId, extra = {}) {
  put(path.join(directory, ".profilepilot-managed.json"), JSON.stringify({ version: 1, managedBy: "ProfilePilot", skillId, ...extra }));
}
function backups(home) {
  const root = path.join(home, ".profilepilot", "skill-backups");
  return fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name)) : [];
}

test("one bundled skill serves every old installation entry point", async t => {
  const home = fixture(t);
  const skills = await inspectAgentSkills(home);
  assert.deepEqual(skills.map(skill => [skill.key, skill.skillId]), [["profilepilot", "profilepilot"]]);
  assert.equal(skills[0].error, null);
  for (const key of ["profilepilot", "agent-browser", "playwright-cli", "chrome-devtools-mcp", "profilepilot-cli"]) {
    assert.equal(bundledAgentSkillPath(key), bundledAgentSkillPath("profilepilot"));
    assert.deepEqual(agentSkillTargetPaths(key, home), agentSkillTargetPaths("profilepilot", home));
  }
  assert.equal((await inspectProfilePilotCliSkill(home)).key, "profilepilot");
  const root = bundledAgentSkillPath("profilepilot");
  const source = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  const links = [...source.matchAll(/\]\((references\/[^)]+)\)/g)].map(match => match[1]);
  assert.ok(links.length >= 6);
  for (const link of links) assert.ok(fs.statSync(path.join(root, link)).isFile(), link);
  assert.equal(fs.existsSync(path.join(root, "local")), false, "personal policy is not shipped to other users");
});

test("installation updates all references and preserves personal routing across updates and removal", async t => {
  const home = fixture(t);
  let diagnostic = await setAgentSkillEnabled("playwright-cli", true, home);
  assert.equal(diagnostic.managedTargetCount, 3);
  assert.equal(diagnostic.upToDate, true);
  const target = diagnostic.targets[0].path;
  const policy = path.join(target, "local", "browser-routing.md");
  put(policy, "Default Profile uses @Chrome.");
  const phonePolicy = path.join(target, "local", "phone-control.md");
  put(phonePolicy, "Prefer my Android phone in view mode.");
  assert.equal((await inspectAgentSkill("profilepilot", home)).upToDate, true);
  const reference = path.join(target, "references", "browser-extension.md");
  put(reference, "user-edited old reference");
  assert.equal((await inspectAgentSkill("profilepilot", home)).upToDate, false);
  diagnostic = await setAgentSkillEnabled("agent-browser", true, home);
  assert.equal(diagnostic.upToDate, true);
  assert.equal(fs.readFileSync(policy, "utf8"), "Default Profile uses @Chrome.");
  assert.equal(fs.readFileSync(phonePolicy, "utf8"), "Prefer my Android phone in view mode.");
  assert.ok(backups(home).some(dir => fs.existsSync(path.join(dir, "references", "browser-extension.md")) &&
    fs.readFileSync(path.join(dir, "references", "browser-extension.md"), "utf8") === "user-edited old reference"));
  diagnostic = await setAgentSkillEnabled("profilepilot-cli", false, home);
  assert.equal(diagnostic.installedTargetCount, 0);
  assert.equal(fs.existsSync(path.join(target, "SKILL.md")), false);
  assert.equal(fs.readFileSync(policy, "utf8"), "Default Profile uses @Chrome.");
  assert.equal(fs.readFileSync(phonePolicy, "utf8"), "Prefer my Android phone in view mode.");
  diagnostic = await setAgentSkillEnabled("profilepilot", true, home);
  assert.equal(diagnostic.upToDate, true);
  assert.equal(fs.readFileSync(policy, "utf8"), "Default Profile uses @Chrome.");
  assert.equal(fs.readFileSync(phonePolicy, "utf8"), "Prefer my Android phone in view mode.");
});

test("migration archives managed legacy content verbatim and leaves external legacy skills", async t => {
  const home = fixture(t);
  const targets = agentSkillTargetPaths("profilepilot", home);
  const owned = path.join(path.dirname(targets[0].path), "agent-browser-cdp");
  const external = path.join(path.dirname(targets[1].path), "playwright-cli-profilepilot");
  put(path.join(owned, "SKILL.md"), "personal changes in a managed old skill");
  put(path.join(owned, "references", "extra.md"), "additional guidance");
  marker(owned, "agent-browser-cdp");
  put(path.join(external, "SKILL.md"), "externally maintained");
  const result = await setAgentSkillEnabled("profilepilot", true, home);
  assert.equal(result.upToDate, true);
  assert.equal(fs.existsSync(owned), false);
  assert.deepEqual(result.legacySkillPaths, [external]);
  const backup = backups(home).find(dir => path.basename(dir).startsWith("shared-agent-browser-cdp-"));
  assert.equal(fs.readFileSync(path.join(backup, "SKILL.md"), "utf8"), "personal changes in a managed old skill");
  assert.equal(fs.readFileSync(path.join(backup, "references", "extra.md"), "utf8"), "additional guidance");
  assert.equal(fs.readFileSync(path.join(external, "SKILL.md"), "utf8"), "externally maintained");
});

test("external unified skills and invalid ownership markers are not overwritten or removed", async t => {
  const home = fixture(t);
  const targets = agentSkillTargetPaths("profilepilot", home);
  put(path.join(targets[0].path, "SKILL.md"), "external unified skill");
  marker(targets[0].path, "profilepilot", { managedBy: "someone else" });
  const legacy = path.join(path.dirname(targets[1].path), "agent-browser-cdp");
  put(path.join(legacy, "SKILL.md"), "external legacy");
  marker(legacy, "different-skill");
  let diagnostic = await setAgentSkillEnabled("profilepilot", true, home);
  assert.equal(diagnostic.managedTargetCount, 2);
  assert.equal(diagnostic.installed, true);
  assert.equal(diagnostic.upToDate, false);
  diagnostic = await setAgentSkillEnabled("profilepilot", false, home);
  assert.equal(diagnostic.installedTargetCount, 1);
  assert.equal(fs.readFileSync(path.join(targets[0].path, "SKILL.md"), "utf8"), "external unified skill");
  assert.equal(fs.readFileSync(path.join(legacy, "SKILL.md"), "utf8"), "external legacy");
});

test("directory links stay externally managed even when their destination has a managed marker", async t => {
  const home = fixture(t);
  const target = agentSkillTargetPaths("profilepilot", home)[0].path;
  const external = path.join(home, "external-source");
  put(path.join(external, "SKILL.md"), "linked personal skill");
  marker(external, "profilepilot");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(external, target, process.platform === "win32" ? "junction" : "dir");
  const result = await setAgentSkillEnabled("profilepilot", true, home);
  assert.equal(result.targets[0].managed, false);
  await setAgentSkillEnabled("profilepilot", false, home);
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(external, "SKILL.md"), "utf8"), "linked personal skill");
});

test("missing or extra reference files mark an installation stale", async t => {
  const home = fixture(t);
  const result = await setAgentSkillEnabled("profilepilot", true, home);
  const target = result.targets[0].path;
  fs.unlinkSync(path.join(target, "references", "profiles.md"));
  assert.equal((await inspectAgentSkill("profilepilot", home)).upToDate, false);
  await setAgentSkillEnabled("profilepilot", true, home);
  put(path.join(target, "references", "obsolete.md"), "old rules");
  assert.equal((await inspectAgentSkill("profilepilot", home)).upToDate, false);
  await setAgentSkillEnabled("profilepilot", true, home);
  assert.equal(fs.existsSync(path.join(target, "references", "obsolete.md")), false);
  assert.equal((await inspectAgentSkill("profilepilot", home)).upToDate, true);
});

test("concurrent legacy callers converge on one complete shared installation", async t => {
  const home = fixture(t);
  const results = await Promise.all(["agent-browser", "playwright-cli", "profilepilot-cli"].map(key => setAgentSkillEnabled(key, true, home)));
  assert.ok(results.every(result => result.installed && result.upToDate));
  for (const target of results[0].targets) {
    assert.deepEqual(fs.readdirSync(path.dirname(target.path)), ["profilepilot"]);
  }
});

test("failed replacement restores the previous skill and personal policy", async t => {
  const home = fixture(t);
  const result = await setAgentSkillEnabled("profilepilot", true, home);
  const target = result.targets[0].path;
  put(path.join(target, "local", "browser-routing.md"), "keep me");
  put(path.join(target, "references", "agent-browser.md"), "previous release");
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (String(from).includes(".profilepilot-tmp-") && to === target) throw Object.assign(new Error("commit failed"), { code: "EACCES" });
    return original(from, to);
  };
  try { await assert.rejects(setAgentSkillEnabled("profilepilot", true, home), /commit failed/); }
  finally { fs.promises.rename = original; }
  assert.equal(fs.readFileSync(path.join(target, "local", "browser-routing.md"), "utf8"), "keep me");
  assert.equal(fs.readFileSync(path.join(target, "references", "agent-browser.md"), "utf8"), "previous release");
  assert.equal((await inspectAgentSkill("profilepilot", home)).upToDate, false);
});

test("archive supports a different filesystem volume", async t => {
  const home = fixture(t);
  const target = agentSkillTargetPaths("profilepilot", home)[0].path;
  const legacy = path.join(path.dirname(target), "agent-browser-cdp");
  put(path.join(legacy, "SKILL.md"), "cross-volume legacy");
  marker(legacy, "agent-browser-cdp");
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (from === legacy) throw Object.assign(new Error("cross device"), { code: "EXDEV" });
    return original(from, to);
  };
  try { assert.equal((await setAgentSkillEnabled("profilepilot", true, home)).upToDate, true); }
  finally { fs.promises.rename = original; }
  assert.equal(fs.existsSync(legacy), false);
  assert.ok(backups(home).some(dir => fs.readFileSync(path.join(dir, "SKILL.md"), "utf8") === "cross-volume legacy"));
});

test("CODEX_HOME selects the Codex target without leaking into alternate homes", t => {
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(os.tmpdir(), "codex-home-skill-test");
  try {
    const normal = agentSkillTargetPaths("profilepilot").find(target => target.host === "codex");
    assert.equal(normal.path, path.join(process.env.CODEX_HOME, "skills", "profilepilot"));
    const home = fixture(t);
    const isolated = agentSkillTargetPaths("profilepilot", home).find(target => target.host === "codex");
    assert.equal(isolated.path, path.join(home, ".codex", "skills", "profilepilot"));
  } finally {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  }
});
