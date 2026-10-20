import { build } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist", "browser-runtime");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ["src/main/browser-engine/cli.ts"], bundle: true,
  platform: "node", format: "cjs", target: "node22", external: ["playwright-core"],
  outfile: path.join(output, "profilepilot-browser-engine.cjs"), logLevel: "warning"
});
// A physical runtime works with both Node and Electron outside app.asar.
const dependency = path.dirname(require.resolve("playwright-core/package.json"));
await cp(dependency, path.join(output, "node_modules", "playwright-core"), { recursive: true });
await writeFile(path.join(output, "package.json"), JSON.stringify({ private: true, type: "commonjs", dependencies: { "playwright-core": require("playwright-core/package.json").version } }, null, 2) + "\n");
