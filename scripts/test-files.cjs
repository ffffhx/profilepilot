const { readdirSync } = require("node:fs");
const path = require("node:path");

function discoverTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return discoverTestFiles(file);
    return entry.isFile() && entry.name.endsWith(".test.js") ? [file] : [];
  }).sort();
}

module.exports = { discoverTestFiles };
