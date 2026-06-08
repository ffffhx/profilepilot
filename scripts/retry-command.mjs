import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const [, , command, ...args] = process.argv;
const attempts = Number(process.env.BUILD_RETRIES || 3);

if (!command) {
  console.error("Usage: node scripts/retry-command.mjs <command> [...args]");
  process.exit(2);
}

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      stdio: "inherit"
    });

    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  if (attempt > 1) {
    await rm("release", { force: true, recursive: true });
    console.log(`Retrying build command, attempt ${attempt} of ${attempts}.`);
  }

  const code = await runOnce();
  if (code === 0) {
    process.exit(0);
  }

  if (attempt === attempts) {
    process.exit(code);
  }
}
