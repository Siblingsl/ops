// R9-1：Electron 长跑采样器——每 5 分钟记录 Electron 相关进程的 RSS/句柄/线程数到 CSV。
// 用法：node r9-longrun-sample.mjs <durationMinutes> <outCsv> [append]
// 采样对象：electron.exe 进程，排除并行走查实例（命令行含 ops-r10a），过滤逻辑在 %TEMP%\r9-sample.ps1。
import { execSync } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';

const minutes = Number(process.argv[2] ?? 120);
const out = process.argv[3] ?? '.playwright-results/r9-longrun.csv';
const append = process.argv[4] === 'append';
const header = 'ts,elapsed_min,electron_procs,total_rss_mb,max_rss_mb,handle_total,thread_total\n';
if (!append || !existsSync(out)) writeFileSync(out, header);

function sample() {
  try {
    const ps1 = (process.env.TEMP ?? '/tmp') + '/r9-sample.ps1';
    const raw = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { encoding: 'utf8', timeout: 30000 });
    let rows = [];
    if (raw.trim()) {
      const parsed = JSON.parse(raw.trim());
      rows = Array.isArray(parsed) ? parsed : [parsed];
    }
    const procs = rows.length;
    const totalRSS = rows.reduce((a, r) => a + Number(r.WS ?? 0), 0) / 1048576;
    const maxRSS = rows.reduce((a, r) => Math.max(a, Number(r.WS ?? 0)), 0) / 1048576;
    const handles = rows.reduce((a, r) => a + Number(r.H ?? 0), 0);
    const threads = rows.reduce((a, r) => a + Number(r.T ?? 0), 0);
    return { procs, totalRSS, maxRSS, handles, threads };
  } catch (e) {
    return { error: String(e).slice(0, 80) };
  }
}

const start = Date.now();
const deadline = start + minutes * 60000;
while (Date.now() < deadline) {
  const s = sample();
  const ts = new Date().toISOString();
  const elapsed = ((Date.now() - start) / 60000).toFixed(1);
  const line = s.error
    ? `${ts},${elapsed},ERROR,0,0,0,0`
    : `${ts},${elapsed},${s.procs},${s.totalRSS.toFixed(1)},${s.maxRSS.toFixed(1)},${s.handles},${s.threads}`;
  appendFileSync(out, line + '\n');
  console.log(line);
  await new Promise((r) => setTimeout(r, 5 * 60000));
}
console.log('R9-1 sampling complete');
