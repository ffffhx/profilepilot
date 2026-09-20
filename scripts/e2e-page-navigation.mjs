import assert from "node:assert/strict";
import { launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const app = await launchProfilePilotE2e({ name: "task cold start", env: { CPM_START_VIEW: "tasks" } });
try {
  const d = app.driver;
  await d.waitFor("#create-task");
  await d.domInput("#prompt", "浏览器列表加载期间输入的要求");
  await d.waitFor("#create-task button.primary", button => !button.disabled);
  assert.equal(await d.evaluate('document.querySelector("#prompt").value'), "浏览器列表加载期间输入的要求");

  const profile = await d.evaluate(`window.profileManager.createProfile('导航状态验证').then(s => s.profiles.find(p => p.name === '导航状态验证'))`);
  await d.domClick('a[href="./index.html"]');
  await d.waitFor('a[href="./tasks.html"]');
  assert.ok((await d.evaluate('document.body.innerText')).includes("导航状态验证"));
  await d.evaluate(`window.profileManager.renameProfile(${JSON.stringify(profile.id)}, '导航状态已更新')`);
  await d.domClick('a[href="./tasks.html"]');
  await d.waitFor('select[name="profileId"]', field => field.text.includes("导航状态已更新"));
  assert.ok(!(await d.evaluate('document.querySelector("select[name=profileId]").textContent')).includes("导航状态验证"));
  await d.domClick('[data-nav="settings"]');
  await d.waitFor("#settings-form");
  console.log("PASS task cold start, draft preservation during profile loading, navigation after profile create/rename, settings access");
} finally {
  await app.stop();
}
process.exit(0);
