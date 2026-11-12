'use strict';
// computer-worker 是独立 JS 进程（目录形态，DEV-CU P2-0 由单文件拆分而来），不参与 tsc 编译
// （tsconfig 只 include src/**/*.ts）。生产路径用
// utilityProcess.fork(path.join(__dirname, 'computer-worker', 'index.js'))，
// 因此每次 build 都要把整个目录复制到 .build/，否则选窗器会在运行期报 computer_worker_unavailable。
// browser-bridge/diagnostics.html 同理：诊断窗 loadFile(__dirname/browser-bridge/diagnostics.html)，
// 该 HTML 不参与编译（DT-02 修复前从未进入 .build，诊断窗加载必然失败）。

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const targets = [
  { source: path.join(root, 'src', 'computer-worker'), target: path.join(root, '.build', 'computer-worker'), dir: true },
  {
    source: path.join(root, 'src', 'browser-bridge', 'diagnostics.html'),
    target: path.join(root, '.build', 'browser-bridge', 'diagnostics.html'),
  },
];

for (const { source, target, dir } of targets) {
  if (!fs.existsSync(source)) {
    console.error(`[copy-worker-assets] 缺少 ${path.relative(root, source)}`);
    process.exit(1);
  }
  if (dir) {
    // 先清目标目录：避免已删除的模块残留在 .build 里被子进程误 require。
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  console.log(`[copy-worker-assets] ${path.relative(root, target)}`);
}

// P2-0 拆目录前的单文件产物：若历史 build 残留，清掉以免被当成入口。
const stale = path.join(root, '.build', 'computer-worker.js');
if (fs.existsSync(stale)) {
  fs.rmSync(stale, { force: true });
  console.log('[copy-worker-assets] 清理旧产物 .build/computer-worker.js');
}
