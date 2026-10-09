const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');
const esbuild = require('esbuild');
const { loadTsModule } = require('./helpers/load-ts-module.js');

const publicDir = path.resolve(__dirname, '../public');
const html = fs.readFileSync(path.join(publicDir, 'tasks.html'), 'utf8');
const links = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
const styles = links.map(href => {
  assert.match(href, /^\.\.?\//, 'expected local shipped stylesheet: ' + href);
  const absolute = path.resolve(publicDir, href);
  const relative = path.relative(path.resolve(publicDir, '..'), absolute);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'stylesheet must stay in the shipped app: ' + href);
  const file = path.relative(publicDir, absolute).split(path.sep).join('/');
  const css = fs.readFileSync(absolute, 'utf8');
  return { file, css, root: postcss.parse(css, { from: file }) };
});

// Follow the shipped order, specificity, !important and media queries.
// Merging named :root blocks would miss the old system-light rule outranking
// the shared theme. This models root tokens, not general browser layout.
function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function specificity(selector) {
  const result = [0, 0, 0];
  for (const node of selector.nodes) {
    if (node.type === 'id') result[0]++;
    else if (node.type === 'class' || node.type === 'attribute') result[1]++;
    else if (node.type === 'tag') result[2]++;
    else if (node.type === 'pseudo') {
      if (node.value === ':where') continue;
      if ([':is', ':not', ':has'].includes(node.value)) {
        const highest = node.nodes.map(specificity).sort(compare).at(-1) || [0, 0, 0];
        highest.forEach((value, index) => { result[index] += value; });
      } else if (node.value.startsWith('::')) result[2]++;
      else result[1]++;
    }
  }
  return result;
}

function matchesRoot(selector, environment) {
  return selector.nodes.every(node => {
    if (node.type === 'comment' || node.type === 'universal') return true;
    if (node.type === 'tag') return node.value === 'html';
    if (node.type === 'class') return environment.classes.has(node.value);
    if (node.type === 'attribute') {
      const actual = environment.attributes[node.attribute];
      if (!node.operator) return actual !== undefined;
      assert.equal(node.operator, '=', 'unsupported root attribute operator: ' + node);
      return actual === node.value;
    }
    if (node.type === 'pseudo') {
      if (node.value === ':root') return true;
      if (node.value === ':not') return !node.nodes.some(child => matchesRoot(child, environment));
      if (node.value === ':is' || node.value === ':where') return node.nodes.some(child => matchesRoot(child, environment));
    }
    return false; // Descendants, interactive states and pseudo-elements are not the root.
  });
}

function mediaMatches(query, environment) {
  return query.split(',').some(branch => {
    const terms = [...branch.matchAll(/\(([\w-]+)\s*:\s*([^)]+)\)/g)];
    const remainder = branch.replace(/\([^)]+\)/g, '').replace(/\band\b|\bscreen\b|\ball\b/g, '').trim();
    assert.equal(remainder, '', 'unsupported root media condition: ' + query);
    return terms.every(([, feature, value]) => {
      value = value.trim();
      if (feature === 'prefers-color-scheme') return value === environment.system;
      if (feature === 'prefers-reduced-motion') return value === 'no-preference';
      if (feature === 'forced-colors') return value === 'none';
      if (/^(min|max)-(width|height)$/.test(feature)) {
        assert.match(value, /^\d+(?:\.\d+)?px$/);
        const dimension = feature.endsWith('width') ? 1440 : 1000;
        return feature.startsWith('min') ? dimension >= parseFloat(value) : dimension <= parseFloat(value);
      }
      assert.fail('unsupported root media feature: ' + feature);
    });
  });
}

function applicable(rule, environment) {
  for (let parent = rule.parent; parent?.type !== 'root'; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    assert.equal(parent.name, 'media', 'unsupported root-token conditional: @' + parent.name);
    if (!mediaMatches(parent.params, environment)) return false;
  }
  return true;
}

function resolveValue(value, tokens) {
  let resolved = value;
  for (let i = 0; i < 20 && resolved.includes('var('); i++) {
    const next = resolved.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (match, name, fallback) => {
      assert.ok(tokens[name] !== undefined || fallback !== undefined, 'undefined token: ' + name);
      return tokens[name] ?? fallback;
    });
    assert.notEqual(next, resolved, 'unresolved or circular CSS value: ' + value);
    resolved = next;
  }
  assert.ok(!resolved.includes('var('), 'circular CSS value: ' + value);
  return resolved;
}

function palette(theme, system = 'light', fontSize = 'medium') {
  const environment = {
    system,
    classes: new Set(['workspace-layout', 'desktop-window']),
    attributes: { 'data-task-font-size': fontSize, ...(theme === undefined ? {} : { 'data-task-theme': theme }) }
  };
  const winners = new Map();
  let order = 0;
  for (const style of styles) {
    style.root.walkRules(rule => {
      const matching = selectorParser().astSync(rule.selector).nodes.filter(selector => matchesRoot(selector, environment));
      if (!matching.length || !applicable(rule, environment)) return;
      const weight = matching.map(specificity).sort(compare).at(-1);
      for (const declaration of rule.nodes.filter(node => node.type === 'decl')) {
        const rank = [declaration.important ? 1 : 0, ...weight, ++order];
        const previous = winners.get(declaration.prop);
        if (!previous || compare(rank, previous.rank) >= 0) {
          winners.set(declaration.prop, { value: declaration.value, file: style.file, rank });
        }
      }
    });
  }
  const raw = Object.fromEntries([...winners].map(([key, value]) => [key, value.value]));
  const tokens = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, resolveValue(value, raw)]));
  return { tokens, winners };
}

function declarations(selector) {
  const result = {};
  for (const style of styles) {
    style.root.walkRules(rule => {
      if (!rule.selectors.includes(selector) || rule.parent.type !== 'root') return;
      for (const declaration of rule.nodes.filter(node => node.type === 'decl')) result[declaration.prop] = declaration.value;
    });
  }
  assert.ok(Object.keys(result).length, 'shipped component selector missing: ' + selector);
  return result;
}

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i, 'contrast test requires opaque sRGB: ' + hex);
  const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

function colorsSufficient(foreground, background, minimum, label) {
  const values = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  const actual = (values[0] + .05) / (values[1] + .05);
  assert.ok(actual >= minimum, label + ': ' + foreground + ' on ' + background + ' = ' + actual.toFixed(4) + ':1; expected >= ' + minimum + ':1');
}

function sufficient(tokens, foreground, background, minimum) {
  assert.ok(tokens[foreground], foreground + ' must be defined');
  assert.ok(tokens[background], background + ' must be defined');
  colorsSufficient(tokens[foreground], tokens[background], minimum, foreground + ' / ' + background);
}

const cases = [
  ['explicit light / light OS', 'light', 'light'],
  ['explicit light / dark OS', 'light', 'dark'],
  ['explicit dark / light OS', 'dark', 'light'],
  ['explicit dark / dark OS', 'dark', 'dark'],
  ['system light', 'system', 'light'],
  ['system dark', 'system', 'dark']
].map(([name, theme, system]) => ({ name, theme, system }));

test('Agent HTML loads the shared theme after legacy, visual and window layers', () => {
  const visual = links.indexOf('./tasks-visual.css');
  const shared = links.indexOf('./design-system.css');
  assert.ok(visual >= 0 && shared >= 0, 'both presentation layers must ship');
  assert.ok(visual > links.indexOf('./tasks.css'));
  assert.ok(visual > links.indexOf('./workspace-switcher.css'));
  assert.ok(shared > visual);
  assert.ok(shared > links.indexOf('./window-chrome.css'));
});

test('every shipped Agent stylesheet, including the shared theme, parses and compiles without warnings', async () => {
  // Each link is a separate stylesheet; concatenation would move a valid
  // leading @import behind rules from the previous file. Bundle each entry
  // so imported styles are resolved and validated as the browser loads them.
  for (const style of styles) assert.doesNotThrow(() => postcss.parse(style.css));
  const result = await esbuild.build({ entryPoints: styles.map(style => path.join(publicDir, style.file)),
    bundle: true, write: false, outdir: 'unused-css-test-output', target: 'chrome120', logLevel: 'silent' });
  assert.deepEqual(result.warnings, []);
});

for (const { name, theme, system } of cases) {
  test(name + ': final small text, placeholders and links remain readable', () => {
    const { tokens } = palette(theme, system);
    for (const foreground of ['--ink', '--muted', '--subtle', '--task-placeholder', '--task-link']) {
      for (const background of ['--bg', '--sidebar', '--panel', '--panel-soft', '--raised', '--hover', '--task-user-bg']) {
        sufficient(tokens, foreground, background, 4.5);
      }
    }
    // Navigation hover uses ink, not muted.
    sufficient(tokens, '--muted', '--navigation', 4.5);
    sufficient(tokens, '--ink', '--navigation-hover', 4.5);
    sufficient(tokens, '--accent', '--accent-soft', 4.5);
  });

  test(name + ': final state, primary and hover actions remain readable', () => {
    const { tokens } = palette(theme, system);
    for (const state of ['success', 'warn', 'danger']) {
      sufficient(tokens, '--' + state, '--task-' + state + '-bg', 4.5);
      sufficient(tokens, '--' + state, '--bg', 4.5);
    }
    sufficient(tokens, '--success', '--success-soft', 4.5);
    sufficient(tokens, '--danger', '--danger-soft', 4.5);
    sufficient(tokens, '--task-on-primary', '--task-primary', 4.5);
    sufficient(tokens, '--accent-ink', '--accent', 4.5);
    sufficient(tokens, '--accent-ink', '--accent-bright', 4.5);
  });

  test(name + ': both task and shared focus colors remain visible', () => {
    const { tokens } = palette(theme, system);
    for (const foreground of ['--task-focus', '--focus']) {
      for (const background of ['--bg', '--sidebar', '--panel', '--raised', '--hover', '--navigation', '--navigation-hover']) {
        sufficient(tokens, foreground, background, 3);
      }
    }
  });

  test(name + ': navigation brand is visible on its actual rail surface', () => {
    const { tokens } = palette(theme, system);
    colorsSufficient(tokens['--ink'], tokens['--navigation'], 4.5, 'workspace wordmark');
    colorsSufficient('#1474ff', tokens['--navigation'], 3, 'workspace glyph');
  });
}

test('explicit light and dark palettes really come from the new design system', () => {
  for (const theme of ['light', 'dark']) {
    const { tokens, winners } = palette(theme);
    assert.equal(tokens['color-scheme'], theme);
    for (const token of ['--bg', '--ink', '--muted', '--accent', '--task-primary', '--task-focus']) {
      assert.equal(winners.get(token)?.file, 'design-system.css', theme + ': stale source for ' + token);
    }
    assert.equal(tokens['--task-primary'], tokens['--accent']);
    assert.equal(tokens['--task-on-primary'], tokens['--accent-ink']);
    assert.equal(tokens['--task-focus'], tokens['--focus']);
  }
});

test('system follows the OS with the same final semantics as explicit light or dark', () => {
  for (const system of ['light', 'dark']) {
    const explicit = palette(system, system).tokens;
    const automatic = palette('system', system).tokens;
    assert.equal(automatic['color-scheme'], system);
    const oppositeOS = palette(system, system === 'light' ? 'dark' : 'light').tokens;
    for (const [token, value] of Object.entries(explicit)) {
      if (!/^#[\da-f]{6}$/i.test(value)) continue;
      assert.equal(automatic[token], value, 'system ' + system + ': ' + token);
      assert.equal(oppositeOS[token], value, 'explicit ' + system + ': ' + token);
    }
  }
});

test('shared controls and task states consume the checked final tokens', () => {
  const primary = declarations('.workspace-layout :is(.primary,.solid,.send-task)');
  assert.equal(primary.background, 'var(--accent)');
  assert.equal(primary.color, 'var(--accent-ink)');
  assert.match(declarations('.workspace-layout button:not(:disabled):focus-visible').outline, /var\(--focus\)/);
  assert.match(declarations('button:focus-visible').outline, /var\(--task-focus\)/);
  assert.equal(declarations('.workspace-layout .workspace-status').background, 'var(--success-soft)');
  assert.equal(declarations('.workspace-layout .workspace-status').color, 'var(--success)');
  assert.equal(declarations('.workspace-layout #task-control-takeover').background, 'var(--danger-soft)');
  assert.equal(declarations('.workspace-layout #task-control-takeover').color, 'var(--danger)');
  assert.equal(declarations('.operation-error').background, 'var(--task-danger-bg)');
  assert.equal(declarations('.operation-error').color, 'var(--danger)');
  assert.match(declarations('.compose-input-shell:focus-within')['box-shadow'], /var\(--task-focus\)/);
  assert.match(declarations('.task-composer:focus-within')['border-color'], /var\(--task-focus\)/);
});

test('small, medium and large text preferences survive the shared theme override', () => {
  for (const { theme, system } of cases) {
    for (const [size, pixels] of Object.entries({ small: '14px', medium: '15px', large: '17px' })) {
      const { tokens, winners } = palette(theme, system, size);
      assert.equal(tokens['--task-font-size'], pixels, theme + '/' + system + '/' + size);
      assert.equal(winners.get('--task-font-size').file, 'tasks-visual.css');
      assert.ok(tokens.font.startsWith(pixels + '/1.5 '), 'root text no longer follows size preference: ' + tokens.font);
      assert.equal(tokens['--task-label-size'], 'max(12px, .857rem)');
      assert.equal(tokens['--task-control-size'], 'max(13px, .929rem)');
    }
  }
});

test('workspace defaults to the approved light design and preserves subsequent appearance choices', t => {
  const originalDocument = global.document;
  global.document = { documentElement: { dataset: {} } };
  t.after(() => { global.document = originalDocument; });
  const { applyAppearance, appearanceControls } = loadTsModule('src/renderer/task-workbench-navigation.ts', {
    stubs: { './task-icons': {}, './task-navigation': {}, './task-rich-text': {}, './task-interaction-model': {} }
  });
  const controls = appearanceControls();
  applyAppearance({ getItem: key => ({ 'profilepilot-task-theme': 'dark', 'profilepilot-task-font-size': 'large' })[key] });
  assert.equal(document.documentElement.dataset.taskTheme, 'light');
  assert.equal(document.documentElement.dataset.taskFontSize, 'large');
  for (const theme of ['light', 'dark', 'system']) {
    assert.match(controls, new RegExp('value="' + theme + '"'));
    for (const fontSize of ['small', 'medium', 'large']) {
      applyAppearance({ getItem: key => ({ 'profilepilot-workspace-theme': theme, 'profilepilot-task-font-size': fontSize })[key] });
      assert.equal(document.documentElement.dataset.taskTheme, theme);
      assert.equal(document.documentElement.dataset.taskFontSize, fontSize);
    }
  }
});
