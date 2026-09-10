// Compatibility for direct `node --test tests/` callers. npm and CI use the
// same discovery with separate test processes through scripts/run-tests.mjs.
const { discoverTestFiles } = require("../scripts/test-files.cjs");
for (const file of discoverTestFiles(__dirname)) require(file);
