// Compile only requested CLI modules, in memory. Never reads/writes shared dist.
const { buildSync } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');
const cache = new Map();
exports.loadCli = function loadCli(file) {
  const source = path.resolve(__dirname, '..', file);
  if (cache.has(source)) return cache.get(source);
  const result = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], logLevel: 'silent' });
  const instance = new Module(source, module);
  instance.filename = source;
  instance.paths = Module._nodeModulePaths(path.dirname(source));
  instance._compile(result.outputFiles[0].text, source);
  cache.set(source, instance.exports);
  return instance.exports;
};
