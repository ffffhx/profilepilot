const { existsSync, chmodSync } = require("node:fs");
const path = require("node:path");

module.exports = async function verifyBrowserRuntime(context) {
  const platform = context.electronPlatformName;
  const arch = ({ 0: "ia32", 1: "x64", 3: "arm64" })[context.arch];
  const target = platform === "win32" ? "x64" : arch;
  const binary = `agent-browser-${platform}-${target}${platform === "win32" ? ".exe" : ""}`;
  const source = path.join(context.packager.projectDir, "node_modules", "agent-browser", "bin", binary);
  if (!existsSync(source)) throw new Error(`Missing bundled browser runtime: ${binary}. Install the locked dependencies before packaging.`);
  if (process.platform !== "win32") chmodSync(source, 0o755);
};
