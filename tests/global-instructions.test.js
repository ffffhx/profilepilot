const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadInstructions(home) {
  return loadTsModule("src/main/global-instructions.ts", {
    stubs: {
      "node:os": { homedir: () => home }
    }
  });
}

test("global instruction save detects conflicts, preserves a divergent reference, and can undo", async () => {
  const home = path.join(os.tmpdir(), `profilepilot-rules-${process.pid}-${Date.now()}`);
  const agentsPath = path.join(home, ".codex", "AGENTS.md");
  const claudePath = path.join(home, ".claude", "CLAUDE.md");
  mkdirSync(path.dirname(agentsPath), { recursive: true });
  mkdirSync(path.dirname(claudePath), { recursive: true });
  writeFileSync(agentsPath, "original rule\n");
  writeFileSync(claudePath, "custom claude rule\n");
  const instructions = loadInstructions(home);

  try {
    const before = await instructions.readGlobalInstructions();
    const agents = before.files.find((file) => file.id === "codex-agents");
    const claude = before.files.find((file) => file.id === "claude-memory");
    assert.equal(claude.diagnostics[0].code, "REFERENCE_SHELL_DIVERGED");

    const changed = await instructions.writeGlobalInstruction({
      id: "codex-agents",
      content: "updated rule\n",
      expectedRevision: agents.revision
    });
    assert.equal(readFileSync(agentsPath, "utf8"), "updated rule\n");
    assert.equal(readFileSync(claudePath, "utf8"), "custom claude rule\n");
    assert.ok(changed.undoAvailableIds.includes("codex-agents"));

    await assert.rejects(
      instructions.writeGlobalInstruction({
        id: "codex-agents",
        content: "stale overwrite\n",
        expectedRevision: agents.revision
      }),
      (error) => error?.code === "GLOBAL_INSTRUCTION_CONFLICT"
    );

    const current = changed.files.find((file) => file.id === "codex-agents");
    await instructions.undoGlobalInstruction({
      id: "codex-agents",
      expectedRevision: current.revision
    });
    assert.equal(readFileSync(agentsPath, "utf8"), "original rule\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
