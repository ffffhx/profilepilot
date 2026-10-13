import { build } from "esbuild";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// tsc/esbuild do not remove outputs whose source files were deleted. Keep old
// local builds from shipping the retired drivers in electron-builder's dist/**.
for (const driver of ["playwright-cli", "chrome-devtools-mcp"]) {
  for (const name of [`${driver}-wrapper.js`, `profilepilot-${driver}-wrapper.cjs`]) {
    rmSync(path.join(root, "dist", "main", name), { force: true });
  }
}

await build({
  absWorkingDir: root,
  entryPoints: ["src/main/agent-browser-wrapper.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/main/profilepilot-agent-browser-wrapper.cjs",
  logLevel: "warning"
});
