const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

module.exports = async function verifyPackagedBrowserRuntime(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const runtime = path.join(resources, "browser-runtime");
  // electron-builder excludes a FileSet's root node_modules directory. Keep an
  // explicit dependency FileSet and validate the final copy on both platforms.
  for (const relative of [
    "profilepilot-browser-engine.cjs",
    "node_modules/playwright-core/package.json",
    "node_modules/playwright-core/index.js",
    "node_modules/playwright-core/lib/coreBundle.js",
    "node_modules/playwright-core/LICENSE",
    "node_modules/playwright-core/NOTICE"
  ]) {
    if (!existsSync(path.join(runtime, relative))) throw new Error(`Packaged browser engine is incomplete: ${relative}`);
  }
  const dependency = JSON.parse(readFileSync(path.join(runtime, "node_modules/playwright-core/package.json"), "utf8"));
  const project = JSON.parse(readFileSync(path.join(context.packager.projectDir, "package.json"), "utf8"));
  if (dependency.version !== project.dependencies["playwright-core"]) throw new Error("Packaged Playwright version does not match the pinned engine dependency");
};
