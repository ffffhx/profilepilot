import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "./build.mjs";
await mkdir(path.join(root, "artifacts"), { recursive: true });
await build({
  stdin: { contents: 'export * from "./src/shared"; export * from "./src/dom"; export * from "./src/reader"; export * from "./src/provider"; export * from "./src/native";', resolveDir: root },
  bundle: true, outfile: path.join(root, "artifacts/test-lib.mjs"), format: "esm", platform: "node", target: "node22"
});
await build({
  entryPoints: [path.join(root, "src/background.ts")], bundle: true,
  outfile: path.join(root, "artifacts/background-test.mjs"), format: "esm", platform: "node", target: "node22"
});
const result = spawnSync(process.execPath, ["--test", "tests/extension.test.mjs", "tests/background.test.mjs"], { cwd: root, stdio: "inherit" });
process.exitCode = result.status || 0;
