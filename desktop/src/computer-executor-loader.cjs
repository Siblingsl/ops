'use strict';
// DEV-CU P4-11：computer-command-executor.ts 的 CJS 加载器。
// desktop 的 node --test 直接跑 .cjs，无法 require .ts；用 desktop 自带的
// typescript 包现场转译一次（缓存到临时目录），与主进程 tsc 构建产物（.build）隔离。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SRC = path.join(__dirname, 'computer-command-executor.ts');
const CACHE = path.join(os.tmpdir(), 'ops-cu11-executor-' + process.pid + '.cjs');

function transpile() {
  if (fs.existsSync(CACHE)) return CACHE;
  const ts = require('typescript');
  const out = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: SRC,
  });
  // 转译产物里的相对 import 保留 './browser-executor'，但其解析基准是缓存文件
  // 所在的 tmpdir——改成对 src 目录的绝对路径，require 才能命中真源文件
  //（browser-executor.ts 同样由 typescript 转译后缓存加载）。
  const bsSrc = path.join(__dirname, 'browser-executor.ts');
  const bsOut = ts.transpileModule(fs.readFileSync(bsSrc, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: bsSrc,
  });
  const bsCache = path.join(os.tmpdir(), 'ops-cu11-browser-' + process.pid + '.cjs');
  fs.writeFileSync(bsCache, bsOut.outputText, 'utf8');
  fs.writeFileSync(CACHE, out.outputText.replace('require("./browser-executor")', 'require(' + JSON.stringify(bsCache) + ')'), 'utf8');
  return CACHE;
}

module.exports = require(transpile());
