const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { validateUnpackedExtensionPath } = require("../dist/main/unpacked-extension.js");

test("unpacked extension validation accepts a canonical Manifest V3 directory", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-unpacked-extension-"));
  const extensionPath = path.join(home, "extension");
  mkdirSync(extensionPath);
  writeFileSync(path.join(extensionPath, "manifest.json"), `${JSON.stringify({
    manifest_version: 3,
    name: "Fixture Extension",
    version: "1.2.3"
  })}\n`);
  try {
    const validated = validateUnpackedExtensionPath(extensionPath);
    assert.equal(validated.path, realpathSync(extensionPath));
    assert.equal(validated.name, "Fixture Extension");
    assert.equal(validated.version, "1.2.3");
    assert.equal(validated.manifestVersion, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unpacked extension validation rejects relative, missing and malformed manifests", () => {
  assert.throws(
    () => validateUnpackedExtensionPath("relative/extension"),
    (error) => error.code === "EXTENSION_PATH_MUST_BE_ABSOLUTE"
  );

  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-unpacked-extension-invalid-"));
  const extensionPath = path.join(home, "extension");
  mkdirSync(extensionPath);
  try {
    assert.throws(
      () => validateUnpackedExtensionPath(extensionPath),
      (error) => error.code === "EXTENSION_MANIFEST_NOT_FOUND"
    );
    writeFileSync(path.join(extensionPath, "manifest.json"), "{bad json\n");
    assert.throws(
      () => validateUnpackedExtensionPath(extensionPath),
      (error) => error.code === "EXTENSION_MANIFEST_INVALID"
    );
    writeFileSync(path.join(extensionPath, "manifest.json"), `${JSON.stringify({
      manifest_version: 1,
      name: "Old Extension"
    })}\n`);
    assert.throws(
      () => validateUnpackedExtensionPath(extensionPath),
      (error) => error.code === "EXTENSION_MANIFEST_INVALID"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
