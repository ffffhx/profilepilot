import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import discovery from "./test-files.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = discovery.discoverTestFiles(path.join(root, "tests"));
if (!files.length) throw new Error("No test files found.");
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true
});
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
