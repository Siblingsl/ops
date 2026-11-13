'use strict';
// DEV-CU P4-11 收口：computer-authorizations.ts 的 CJS 加载器（node --test 无法直接 require .ts）。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SRC = path.join(__dirname, 'computer-authorizations.ts');
const CACHE = path.join(os.tmpdir(), 'ops-cu11-auth-' + process.pid + '.cjs');

if (!fs.existsSync(CACHE)) {
  const ts = require('typescript');
  const out = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: SRC,
  });
  fs.writeFileSync(CACHE, out.outputText, 'utf8');
}
module.exports = require(CACHE);
