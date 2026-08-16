const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  agentSkillTargetPaths,
  bundledAgentSkillPath,
  inspectAgentSkill,
  inspectAgentSkills,
  inspectProfilePilotCliSkill,
  setAgentSkillEnabled
} = require("../dist/main/agent-skill-integration.js");

test("ProfilePilot bundles one installable Skill for every supported browser tool", async () => {
  const skills = await inspectAgentSkills(path.join(os.tmpdir(), `profilepilot-empty-home-${process.pid}-${Date.now()}`));
  assert.deepEqual(skills.map((skill) => [skill.key, skill.skillId]), [
    ["agent-browser", "agent-browser-cdp"],
    ["playwright-cli", "playwright-cli-profilepilot"],
    ["chrome-devtools-mcp", "chrome-devtools-mcp-profilepilot"]
  ]);
  for (const skill of skills) {
    const source = fs.readFileSync(path.join(bundledAgentSkillPath(skill.key), "SKILL.md"), "utf8");
    assert.match(source, new RegExp(`name: ${skill.skillId}`));
    assert.match(source, /ProfilePilot/);
    assert.equal(skill.error, null);
  }
});

test("ProfilePilot management CLI has an independent installable Skill", async () => {
  const home = path.join(os.tmpdir(), `profilepilot-cli-skill-home-${process.pid}-${Date.now()}`);
  const skill = await inspectProfilePilotCliSkill(home);
  assert.equal(skill.key, "profilepilot-cli");
  assert.equal(skill.skillId, "profilepilot-cli");
  assert.equal(skill.installed, false);
  const source = fs.readFileSync(path.join(bundledAgentSkillPath("profilepilot-cli"), "SKILL.md"), "utf8");
  assert.match(source, /name: profilepilot-cli/);
  assert.match(source, /profilepilot profile delete/);
  assert.match(source, /explicit user approval/);
});
test("Skill installation writes independent shared, Codex, and Claude copies and removes only managed copies", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-agent-skill-"));
  try {
    let diagnostic = await inspectAgentSkill("playwright-cli", home);
    assert.equal(diagnostic.installed, false);
    assert.equal(diagnostic.installedTargetCount, 0);

    diagnostic = await setAgentSkillEnabled("playwright-cli", true, home);
    assert.equal(diagnostic.installed, true);
    assert.equal(diagnostic.managedTargetCount, 3);
    assert.equal(diagnostic.upToDate, true);
    for (const target of diagnostic.targets) {
      assert.equal(fs.existsSync(path.join(target.path, "SKILL.md")), true);
      assert.equal(fs.existsSync(path.join(target.path, ".profilepilot-managed.json")), true);
    }

    diagnostic = await setAgentSkillEnabled("playwright-cli", false, home);
    assert.equal(diagnostic.installedTargetCount, 0);
    assert.ok(diagnostic.targets.every((target) => !fs.existsSync(target.path)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Skill installation preserves an externally managed copy while filling missing Agent hosts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profilepilot-external-skill-"));
  const targets = agentSkillTargetPaths("agent-browser", home);
  const external = targets[0].path;
  try {
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "SKILL.md"), "---\nname: agent-browser-cdp\ndescription: external\n---\n", "utf8");

    let diagnostic = await setAgentSkillEnabled("agent-browser", true, home);
    assert.equal(diagnostic.installed, true);
    assert.equal(diagnostic.managedTargetCount, 2);
    assert.equal(fs.readFileSync(path.join(external, "SKILL.md"), "utf8").includes("description: external"), true);

    diagnostic = await setAgentSkillEnabled("agent-browser", false, home);
    assert.equal(diagnostic.installed, false);
    assert.equal(diagnostic.installedTargetCount, 1);
    assert.equal(fs.existsSync(path.join(external, "SKILL.md")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
