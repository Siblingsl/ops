'use strict';
// computer-worker.js 是独立 JS 进程文件，不参与 tsc 编译（tsconfig 只 include src/**/*.ts）。
// 生产路径用 utilityProcess.fork(path.join(__dirname, 'computer-worker.js'))，
// 因此每次 build 都要把它复制到 .build/，否则选窗器会在运行期报 computer_worker_unavailable。

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'src', 'computer-worker.js');
const target = path.join(root, '.build', 'computer-worker.js');

if (!fs.existsSync(source)) {
  console.error('[copy-worker-assets] 缺少 src/computer-worker.js');
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log('[copy-worker-assets] .build/computer-worker.js');
