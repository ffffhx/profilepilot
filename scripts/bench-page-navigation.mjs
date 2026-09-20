import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchProfilePilotE2e, repoRoot } from "./e2e/lib/electron-driver.mjs";

const label = process.argv[2] || "current";
const app = await launchProfilePilotE2e({ name: "page navigation benchmark" });
const samples = [];
try {
  for (let round = 0; round < 3; round++) {
    for (const [page, link, ready] of [
      ["tasks", 'a[href="./tasks.html"]', "#create-task"],
      ["browser", 'a[href="./index.html"]', 'a[href="./tasks.html"]']
    ]) {
      const started = performance.now();
      await app.driver.domClick(link);
      await app.driver.waitFor(ready);
      samples.push({ page, round, elapsedMs: Math.round(performance.now() - started) });
    }
  }
  const dir = path.join(repoRoot, "test-results", "navigation");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${label}.json`), JSON.stringify({ label, platform: process.platform, samples }, null, 2));
  console.log(JSON.stringify({ label, samples }));
} finally {
  await app.stop();
}
process.exit(0);
