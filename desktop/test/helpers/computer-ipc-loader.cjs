'use strict';
// DEV-CU P3-6：desktop/src/ipc/computer.ts 的 CJS 加载器（测试专用）。
// 用 desktop 自带 typescript transpileModule 现场转译，缓存到 tmpdir；
// setComputerWorkerHost 暴露给测试以注入 mock host。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SRC = path.join(__dirname, '..', '..', 'src', 'ipc', 'computer.ts');
const CACHE = path.join(os.tmpdir(), 'ops-cu36-ipc-' + process.pid + '.cjs');

let cached = null;

function load() {
  if (cached) return cached;
  const ts = require('typescript');
  const out = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: SRC,
  });
  // 转译产物的相对 import 解析基准是 tmpdir——重写为 src 目录绝对路径，
  // 并递归转译其 TS 依赖（computer-contract 等）。
  let code = out.outputText;
  code = code.replace(/require\("((?:\.\/|\..\/)[^"]+)"\)/g, (m, rel) => {
    const base = rel.endsWith('.js') ? rel.slice(0, -3) : rel;
    const depSrc = path.join(path.dirname(SRC), base.endsWith('.ts') ? base : base + '.ts');
    if (fs.existsSync(depSrc)) {
      return 'require(' + JSON.stringify(transpileDep(depSrc)) + ')';
    }
    return m;
  });
  fs.writeFileSync(CACHE, code, 'utf8');
  cached = require(CACHE);
  return cached;
}

function transpileDep(depSrc) {
  const ts = require('typescript');
  const cache = path.join(os.tmpdir(), 'ops-cu36-dep-' + process.pid + '-' + path.basename(depSrc, '.ts') + '.cjs');
  if (fs.existsSync(cache)) return cache;
  const out = ts.transpileModule(fs.readFileSync(depSrc, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: depSrc,
  });
  let code = out.outputText;
  code = code.replace(/require\("((?:\.\/|\..\/)[^"]+)"\)/g, (m, rel) => {
    const base = rel.endsWith('.js') ? rel.slice(0, -3) : rel;
    const depSrc2 = path.join(path.dirname(depSrc), base.endsWith('.ts') ? base : base + '.ts');
    if (fs.existsSync(depSrc2)) {
      return 'require(' + JSON.stringify(transpileDep(depSrc2)) + ')';
    }
    return m;
  });
  fs.writeFileSync(cache, code, 'utf8');
  return cache;
}

module.exports = {
  loadCompiledIpcComputer: load,
  setComputerWorkerHost: (host) => { load().setComputerWorkerHost(host); },
};
