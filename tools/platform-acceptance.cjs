#!/usr/bin/env node
// 平台采集验收对照工具（SP-PS02 / SP-PS03 正式验收用）。
//
// 用途：从平台后台读一次真实数据，与数据库里的观测逐字段比对，输出验收报告。
// 这是"抓得准不准"的唯一直接证据，代替人工逐篇翻页面。
//
// 用法：
//   node tools/platform-acceptance.cjs <platform> [--json]
//     platform: xhs | wechat_mp
//
// 依赖：desktop/.build 里已编译的适配器（先 cd desktop && pnpm build）。
// profile 取客户端连接命名空间下的真实登录态（不复制、不导出任何凭据）。
//
// 安全：只读。不点发布/删除/修改，不输出任何 Cookie、token、完整账号标识。
// 报告里账号标识只保留前 8 位，用于确认是同一个账号。

const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const worker = require(path.join(DESKTOP, '.build', 'platform-worker.js'));
const login = require(path.join(DESKTOP, '.build', 'platform-login.js'));
const xhsAdapter = require(path.join(DESKTOP, '.build', 'platforms', 'xhs.js'));
const wxAdapter = require(path.join(DESKTOP, '.build', 'platforms', 'wechat-mp.js'));

const DB_URL = process.env.OPS_DATABASE_URL
  || 'postgres://ops:ops_dev_password@localhost:5440/ops?sslmode=disable';

// ---------- 数据库读取 ----------

// psql 用 docker exec 进容器执行，避免要求本机装 psql。
function query(sql) {
  const out = execFileSync('docker', [
    'exec', '-i', 'ops-dev-postgres-1', 'psql', '-U', 'ops', '-d', 'ops',
    '-t', '-A', '-F', '\t', '-c', sql
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split('\n').filter((line) => line.trim() !== '').map((line) => line.split('\t'));
}

// loadObservations 取该平台最近一批观测（按 external_id 取最新一条）。
function loadObservations(platform) {
  const source = platform === 'xhs' ? 'xhs_browser' : 'wechat_browser';
  const rows = query(`SELECT DISTINCT ON (external_id) external_id, values, quality_state,
      (SELECT count(*) FROM platform_metric_observation o2
       WHERE o2.external_id=o.external_id AND o2.source=o.source) AS total_rows
    FROM platform_metric_observation o
    WHERE source='${source}'
    ORDER BY external_id, created_at DESC`);
  const out = new Map();
  for (const row of rows) {
    const [externalId, values, quality, totalRows] = row;
    let parsed = {};
    try { parsed = JSON.parse(values); } catch { parsed = {}; }
    out.set(externalId, { values: parsed, quality, totalRows: Number(totalRows) || 1 });
  }
  return out;
}

// loadBoundWorks 取该平台已精确绑定且已发布的作品数（验收的"应有样本量"）。
function loadBoundWorks(platform) {
  const column = platform === 'xhs' ? 'xhs_note_id' : 'wechat_msgid';
  const rows = query(`SELECT count(*), count(DISTINCT date(published_at))
    FROM work WHERE ${column} IS NOT NULL AND deleted_at IS NULL AND published_at IS NOT NULL
      AND platform_binding_source IN ('user_link','user_confirm','official_exact')`);
  const [count, days] = rows[0] || ['0', '0'];
  return { works: Number(count) || 0, publishDays: Number(days) || 0 };
}

// ---------- 平台读取 ----------

function profileDirFor(platform) {
  // 客户端连接命名空间目录：登录态真正落盘的地方。
  // 这里按目录扫描定位，避免把 user/device ID 硬编码进来。
  const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'OPS Desktop', 'platform-profiles', 'accounts');
  const fs = require('node:fs');
  let found = null;
  for (const user of fs.readdirSync(base, { withFileTypes: true })) {
    if (!user.isDirectory()) continue;
    const platformRoot = path.join(base, user.name, platform);
    if (!fs.existsSync(platformRoot)) continue;
    for (const conn of fs.readdirSync(platformRoot, { withFileTypes: true })) {
      if (!conn.isDirectory()) continue;
      const candidate = path.join(platformRoot, conn.name, 'profile');
      // 选"有 Cookies 且文件最多"的那个（真实登录态所在的目录通常更大）。
      if (!fs.existsSync(path.join(candidate, 'Default', 'Network', 'Cookies'))) continue;
      const size = dirSize(candidate);
      if (!found || size > found.size) found = { dir: candidate, size };
    }
  }
  return found ? found.dir : null;
}

function dirSize(dir) {
  const fs = require('node:fs');
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch { /* 忽略 */ } }
    }
  }
  return total;
}

// readPlatform 用真实登录态读一次平台数据，返回 { notes/articles } 的统一结构。
async function readPlatform(platform) {
  const profileDir = profileDirFor(platform);
  if (!profileDir) throw new Error(`找不到 ${platform} 的本机登录态目录，请先在客户端登录`);
  const candidate = await worker.findPlatformBrowser();
  const browser = await worker.launchPlatformBrowser({
    executablePath: candidate.executablePath, profileDir
  });
  const cdp = worker.createCDPClient(browser, 20_000);
  const session = { platform, profileDir, browser, cdp };
  try {
    const adapter = platform === 'xhs' ? xhsAdapter : wxAdapter;
    const page = await login.openLoginPage(session);
    const landed = page.url;
    if (platform === 'xhs') {
      const discovery = await adapter.collectPostedNotes(login.createPageResponseSource(session), { maxPages: 3 });
      return {
        landed,
        items: discovery.notes.map((n) => ({
          externalId: n.noteId,
          status: n.status,
          metrics: {
            view_times: n.viewTimes,
            like_count: n.likes,
            favorite_count: n.favorites,
            comment_count: n.comments,
            share_times: n.shares
          }
        })),
        coverage: discovery.coverage
      };
    }
    const discovery = await adapter.collectPublishedArticles(login.createPageResponseSource(session), { maxPages: 3 });
    return {
      landed,
      items: discovery.articles.map((a) => ({
        externalId: a.externalID,
        status: a.status,
        metrics: {
          read_times: a.readNum,
          like_count: a.likes,
          comment_count: a.comments,
          share_times: a.shares
        }
      })),
      coverage: discovery.coverage
    };
  } finally {
    await cdp.close();
  }
}

// ---------- 对照 ----------

const FIELD_LABELS = {
  view_times: '观看数', read_times: '阅读数', like_count: '点赞',
  favorite_count: '收藏', comment_count: '评论', share_times: '分享'
};

function compare(platform, platformItems, observations) {
  const rows = [];
  let matched = 0;
  let mismatched = 0;
  let missingObservation = 0;
  for (const item of platformItems) {
    const obs = observations.get(item.externalId);
    if (!obs) {
      missingObservation += 1;
      rows.push({ externalId: item.externalId, status: item.status, fields: [], note: '无观测' });
      continue;
    }
    const fields = [];
    for (const [key, platformValue] of Object.entries(item.metrics)) {
      const obsField = obs.values[key];
      const obsValue = obsField && typeof obsField.value === 'number' ? obsField.value : null;
      const unit = obsField ? obsField.unit : null;
      const precision = obsField ? obsField.precision : null;
      let verdict;
      if (platformValue === null || platformValue === undefined) {
        verdict = obsValue === null ? 'both_missing' : 'obs_has_extra';
      } else if (obsValue === null) {
        verdict = 'obs_missing';
      } else if (obsValue === platformValue) {
        verdict = 'match';
      } else {
        verdict = 'mismatch';
      }
      if (verdict === 'match' || verdict === 'both_missing') matched += 1;
      else mismatched += 1;
      fields.push({
        key, label: FIELD_LABELS[key] || key, platformValue, obsValue, unit, precision, verdict
      });
    }
    rows.push({ externalId: item.externalId, status: item.status, fields, note: '' });
  }
  return { rows, matched, mismatched, missingObservation };
}

// ---------- 输出 ----------

function maskAccount(key) {
  if (!key) return '(未知)';
  const [kind, value] = key.split(':');
  if (!value) return key;
  return `${kind}:${value.slice(0, 8)}…`;
}

function printReport(platform, reading, obsResult, bound, options) {
  const { rows, matched, mismatched, missingObservation } = obsResult;
  const published = reading.items.filter((i) => i.status === 'published');
  const deleted = reading.items.filter((i) => i.status === 'deleted');
  const fieldsTotal = rows.reduce((sum, r) => sum + r.fields.length, 0);

  if (options.json) {
    console.log(JSON.stringify({
      platform, landed: reading.landed, coverage: reading.coverage,
      bound, publishedCount: published.length, deletedCount: deleted.length,
      matched, mismatched, missingObservation, fieldsTotal, rows
    }, null, 2));
    return { matched, mismatched };
  }

  console.log(`\n=== ${platform === 'xhs' ? '小红书' : '公众号'} 验收对照 ===`);
  console.log(`落点        ${reading.landed.slice(0, 70)}`);
  console.log(`平台作品    ${reading.items.length} 条（已发布 ${published.length}、已删除 ${deleted.length}）`);
  console.log(`已绑定作品  ${bound.works} 篇，跨 ${bound.publishDays} 个发布日`);
  console.log(`对照结果    一致 ${matched}、不一致 ${mismatched}、缺观测 ${missingObservation}`);
  console.log(`覆盖        ${JSON.stringify(reading.coverage)}`);

  const bad = rows.filter((r) => r.fields.some((f) => f.verdict === 'mismatch' || f.verdict === 'obs_missing'));
  if (bad.length === 0) {
    console.log('\n逐字段对照：全部一致。');
  } else {
    console.log('\n逐字段对照（仅列出不一致项）：');
    for (const r of bad) {
      console.log(`  ${r.externalId}`);
      for (const f of r.fields) {
        if (f.verdict === 'mismatch' || f.verdict === 'obs_missing') {
          console.log(`    ${f.label}: 平台=${f.platformValue} 观测=${f.obsValue} (${f.verdict}, unit=${f.unit})`);
        }
      }
    }
  }

  // 每字段有效对照数：按**作品**去重，不是按观测条数。
  // §17.1 要求"每字段至少 10 个有效对照"——同一篇作品的多次采集只算一个对照，
  // 否则重复采集会把数字刷上去，看起来达标其实样本只有几篇。
  const perField = new Map();
  for (const r of rows) {
    for (const f of r.fields) {
      if (f.platformValue === null || f.platformValue === undefined) continue;
      perField.set(f.label, (perField.get(f.label) ?? 0) + 1);
    }
  }
  const fieldRows = [...perField.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n每字段有效对照（按作品去重）：');
  for (const [label, count] of fieldRows) {
    console.log(`  ${label.padEnd(6)} ${String(count).padStart(2)} 篇 ${count >= 10 ? '✓' : '✗ 不足 10'}`);
  }

  // 样本量是否达标（§17.1 要求 ≥10 篇、≥3 个发布日、**每字段** ≥10 个对照）。
  const worksEnough = published.length >= 10;
  const daysEnough = bound.publishDays >= 3;
  const fieldsEnough = fieldRows.length > 0 && fieldRows.every(([, count]) => count >= 10);
  const enough = worksEnough && daysEnough && fieldsEnough;
  console.log(
    `\n样本量      ${enough ? '达标' : '不达标'}` +
    `（篇数 ${published.length}/10 ${worksEnough ? '✓' : '✗'}，` +
    `发布日 ${bound.publishDays}/3 ${daysEnough ? '✓' : '✗'}，` +
    `每字段 ≥10 ${fieldsEnough ? '✓' : '✗'}）`
  );
  return { matched, mismatched, enough };
}

// ---------- 主流程 ----------

async function main() {
  const platform = process.argv[2];
  const options = { json: process.argv.includes('--json') };
  if (platform !== 'xhs' && platform !== 'wechat_mp') {
    console.error('用法：node tools/platform-acceptance.cjs <xhs|wechat_mp> [--json]');
    process.exit(2);
  }
  const observations = loadObservations(platform);
  const bound = loadBoundWorks(platform);
  let reading;
  try {
    reading = await readPlatform(platform);
  } catch (error) {
    console.error(`读取平台失败：${error.code || ''} ${error.message}`);
    process.exit(1);
  }
  const result = compare(platform, reading.items, observations);
  printReport(platform, reading, result, bound, options);
  // 只有**字段不一致**才算验收失败。
  // "缺观测"不是问题：已删除的文章本就不该生成观测（§6.3），
  // 未绑定的作品也不在采集范围内（§7.2）。
  process.exit(result.mismatched > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验收工具异常：', error.message);
  process.exit(1);
});
