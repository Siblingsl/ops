'use strict';
// computer-worker.js 是独立 JS 进程文件，不参与 tsc 编译（tsconfig 只 include src/**/*.ts）。
// 生产路径用 utilityProcess.fork(path.join(__dirname, 'computer-worker.js'))，
// 因此每次 build 都要把它复制到 .build/，否则选窗器会在运行期报 computer_worker_unavailable。
// browser-bridge/diagnostics.html 同理：诊断窗 loadFile(__dirname/browser-bridge/diagnostics.html)，
// 该 HTML 不参与编译（DT-02 修复前从未进入 .build，诊断窗加载必然失败）。

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const targets = [
  { source: path.join(root, 'src', 'computer-worker.js'), target: path.join(root, '.build', 'computer-worker.js') },
  {
    source: path.join(root, 'src', 'browser-bridge', 'diagnostics.html'),
    target: path.join(root, '.build', 'browser-bridge', 'diagnostics.html'),
  },
];

for (const { source, target } of targets) {
  if (!fs.existsSync(source)) {
    console.error(`[copy-worker-assets] 缺少 ${path.relative(root, source)}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`[copy-worker-assets] ${path.relative(root, target)}`);
}
