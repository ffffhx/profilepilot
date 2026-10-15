import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extract from "extract-zip";
import { collectPluginFiles, createPluginZip, packageFiles, pluginRoot, syncGeneratedFiles } from "../scripts/package-codex-plugin.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "profilepilot-plugin-test-"));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("profilepilot-plugin-test-"));
    return rm(resolved, { recursive: true, force: true });
  });
  return root;
}

test("the submission ZIP extracts to the complete plugin and is reproducible", async t => {
  await syncGeneratedFiles({ check: true });
  const { manifest, files } = await collectPluginFiles();
  const zip = createPluginZip(files);
  assert.deepEqual(zip, createPluginZip(new Map([...files].reverse())));
  const root = await temporary(t);
  const archive = path.join(root, "plugin.zip");
  const extracted = path.join(root, "extracted");
  await writeFile(archive, zip);
  await extract(archive, { dir: extracted });
  const restored = await collectPluginFiles(extracted);
  assert.deepEqual(restored.manifest, manifest);
  assert.equal(restored.files.size, packageFiles.length);
  for (const [name, bytes] of files) {
    assert.deepEqual(await readFile(path.join(extracted, name)), bytes, name);
  }
  assert.equal(createHash("sha256").update(createPluginZip(restored.files)).digest("hex"), createHash("sha256").update(zip).digest("hex"));
});

test("publication rejects unlisted personal files instead of silently packaging them", async t => {
  const root = await temporary(t);
  await cp(pluginRoot, root, { recursive: true });
  await mkdir(path.join(root, "skills/profilepilot/local"));
  await writeFile(path.join(root, "skills/profilepilot/local/browser-routing.md"), "private user configuration");
  await assert.rejects(collectPluginFiles(root), /unexpected: skills\/profilepilot\/local\/browser-routing.md/);
});

test("publication rejects links to files outside the package", async t => {
  const root = await temporary(t);
  const copied = path.join(root, "plugin");
  await cp(pluginRoot, copied, { recursive: true });
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(copied, "private"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(collectPluginFiles(copied), /Symlinks are not publishable/);
});
