const { existsSync } = require("node:fs");
const path = require("node:path");

module.exports = async function verifyBrowserRuntime(context) {
  const root = path.join(context.packager.projectDir, "dist", "browser-runtime");
  for (const file of ["profilepilot-browser-engine.cjs", "node_modules/playwright-core/package.json", "node_modules/playwright-core/LICENSE"]) {
    if (!existsSync(path.join(root, file))) throw new Error(`Missing TypeScript browser runtime: ${file}. Run npm run build:browser-engine.`);
  }
};
