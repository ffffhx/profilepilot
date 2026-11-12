const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.BUTTON_LAYOUT_FIXTURE;
if (!root) throw new Error('Run scripts/verify-button-layout.mjs');
app.setPath('userData', path.join(root, 'user-data'));
app.on('window-all-closed', () => {});
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
const labels = JSON.parse(fs.readFileSync(path.join(root, 'labels.json'), 'utf8'));
const differences = (before, after) => Object.entries(before).flatMap(([key, box]) => !after[key] ? [{ key, missing: true }] : box.some((n, i) => Math.abs(n - after[key][i]) > .2) ? [{ key, before: box, after: after[key] }] : []);
app.whenReady().then(async () => {
  const results = [];
  try {
    for (const width of [1400, 1000, 760]) {
      const window = new BrowserWindow({ show: false, width, height: 900, useContentSize: true, webPreferences: { backgroundThrottling: false } });
      const evaluate = code => window.webContents.executeJavaScript(code);
      await window.loadFile(path.join(root, 'index.html'));
      const viewport = await evaluate('innerWidth');
      if (Math.abs(viewport - width) > 2) throw new Error(`Viewport did not resize: ${viewport} / ${width}`);
      const scenarios = await evaluate('buttonLayout.scenarios');
      for (const platform of ['win32', 'darwin']) {
        for (const name of scenarios) {
          await evaluate(`buttonLayout.scenario(${JSON.stringify(name)}, false, '${platform}')`);
          const before = await evaluate('buttonLayout.boxes()');
          await evaluate(`buttonLayout.scenario(${JSON.stringify(name)}, true, '${platform}')`);
          const during = await evaluate('buttonLayout.boxes()');
          await evaluate(`buttonLayout.scenario(${JSON.stringify(name)}, false, '${platform}')`);
          const after = await evaluate('buttonLayout.boxes()');
          results.push({ width, platform, name, changes: differences(before, during), restored: differences(before, after) });
        }
      }
      for (const compact of [false, true]) {
        const before = await evaluate(`buttonLayout.labels(${JSON.stringify(labels)},false,${compact})`);
        const after = await evaluate(`buttonLayout.labels(${JSON.stringify(labels)},true,${compact})`);
        results.push({ width, name: compact ? 'compact-labels' : 'labels', count: labels.length, changes: differences(before, after), restored: [] });
      }
      window.destroy();
    }
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
    const failed = results.filter(row => row.changes.length || row.restored.length);
    console.log(JSON.stringify({ cases: results.length, labelPairs: labels.length, failed: failed.map(({width,platform,name,changes,restored}) => ({width,platform,name,changes:changes.slice(0,4),restored})) }));
    app.exit(failed.length ? 1 : 0);
  } catch (error) { console.error(error); app.exit(1); }
});
