const { existsSync, readFileSync } = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "../..");

function loadTsModule(relPath, options = {}) {
  const filename = path.resolve(projectRoot, relPath);
  const stubs = options.stubs || {};
  const cache = options.cache || new Map();

  return loadFile(filename);

  function loadFile(file) {
    const normalizedFile = path.normalize(file);
    if (cache.has(normalizedFile)) {
      return cache.get(normalizedFile).exports;
    }

    const source = readFileSync(normalizedFile, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      },
      fileName: normalizedFile
    }).outputText;

    const mod = new Module(normalizedFile, module.parent);
    mod.filename = normalizedFile;
    mod.paths = Module._nodeModulePaths(path.dirname(normalizedFile));
    cache.set(normalizedFile, mod);

    mod.require = (request) => {
      const stub = findStub(normalizedFile, request);
      if (stub.found) {
        return stub.value;
      }

      const resolvedTs = resolveRelativeTs(normalizedFile, request);
      if (resolvedTs) {
        return loadFile(resolvedTs);
      }

      return Module._load(request, mod, false);
    };

    mod._compile(output, normalizedFile);
    return mod.exports;
  }

  function findStub(fromFile, request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
      return { found: true, value: stubs[request] };
    }

    const resolved = resolveRelativeTs(fromFile, request);
    if (!resolved) {
      return { found: false };
    }

    const keys = [
      resolved,
      toProjectRel(resolved),
      toProjectRel(stripExt(resolved)),
      stripExt(resolved)
    ];

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(stubs, key)) {
        return { found: true, value: stubs[key] };
      }
    }

    return { found: false };
  }
}

function resolveRelativeTs(fromFile, request) {
  if (!request.startsWith(".")) {
    return null;
  }

  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.js")
  ];

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function stripExt(file) {
  return file.replace(/\.[^.]+$/, "");
}

function toProjectRel(file) {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

module.exports = { loadTsModule };
