const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");
const { parseNativeSessionId } = loadTsModule("src/main/session-identity.ts");

test("canonical Session identity accepts only native Codex and Claude UUID sessions", () => {
  assert.deepEqual(
    parseNativeSessionId("cx-12345678-1234-1234-1234-123456789abc"),
    { engine: "codex", nativeSessionId: "12345678-1234-1234-1234-123456789abc" }
  );
  assert.deepEqual(
    parseNativeSessionId("cc-ABCDEF12-1234-1234-1234-123456789ABC"),
    { engine: "claude", nativeSessionId: "ABCDEF12-1234-1234-1234-123456789ABC" }
  );
  assert.equal(parseNativeSessionId("cx-project-name"), null);
  assert.equal(parseNativeSessionId("../unsafe"), null);
});

test("ended Codex Session lookup can resolve a non-default Session Core representation", async () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const nonDefaultFile = `/tmp/orca/sessions/rollout-2026-08-01-${uuid}.jsonl`;
  const { findAgentSessionFile } = loadTsModule("src/main/session-context.ts", {
    stubs: {
      "./session-identity": {
        resolveCanonicalSessionIdentity: async () => ({
          canonicalSessionId: `codex:${uuid}`,
          engine: "codex",
          nativeSessionId: uuid,
          representations: [{
            source: "orca-codex-home",
            filePath: nonDefaultFile,
            mtimeMs: 10,
            sizeBytes: 100
          }],
          diagnostics: []
        })
      },
      "./fs-util": {
        execFileAsync: async () => ({ stdout: "", stderr: "" }),
        POSIX_LOCALE_ENV: {},
        isRecord: () => false,
        stringValue: () => undefined
      }
    }
  });

  assert.deepEqual(await findAgentSessionFile(`cx-${uuid}`), {
    file: nonDefaultFile,
    kind: "codex"
  });
});
