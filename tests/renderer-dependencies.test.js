const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

test('renderer runtime dependencies are acyclic and presentation does not import controllers', () => {
  const root = path.resolve('src/renderer');
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
  const files = new Set(walk(root)), edges = new Map();
  for (const file of files) {
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
    });
    const deps = [...outputText.matchAll(/require\("(\.[^"]*)"\)/g)].flatMap(match => {
      const target = path.resolve(path.dirname(file), match[1]);
      return [target + '.ts', target + '.tsx'].filter(candidate => files.has(candidate));
    });
    edges.set(file, deps);
    if (file.startsWith(path.join(root, 'render') + path.sep)) {
      for (const name of ['busy', 'confirm', 'control-preferences', 'state-actions', 'main']) {
        assert.ok(!deps.includes(path.join(root, name + '.ts')), `${path.relative(root,file)} imports controller ${name}`);
      }
    }
  }
  const visited = new Set(), chain = [];
  function visit(file) {
    assert.ok(!chain.includes(file), `Runtime cycle: ${[...chain, file].map(file => path.relative(root,file)).join(' -> ')}`);
    if (visited.has(file)) return;
    chain.push(file);
    for (const dependency of edges.get(file)) visit(dependency);
    chain.pop(); visited.add(file);
  }
  for (const file of files) visit(file);
});
