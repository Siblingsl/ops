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

// assertAccountId 校验 --account 的形态。SQL 是拼字符串执行的（psql 不走参数绑定），
// 因此账号 ID 必须先严格校验，不能把任意输入直接拼进语句。
function assertAccountId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`--account 需要账号 UUID，实际是 ${JSON.stringify(value)}`);
  }
  return value;
}

// parseDbTimestamp 解析 psql -t -A 输出的 timestamptz（如 2026-10-26 03:22:55.343+00）。
// psql 默认输出 +00 这种两位偏移，而 JS 的 Date 只认 +00:00 / +0000，直接传会得到
// Invalid Date，报告就变成"观测时间未知"——所以偏移必须先补成合法形态。
// 解析不了就返回 null——宁可报告里写"时间未知"，也不要造一个时间出来。
function parseDbTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let normalized = text.includes('T') ? text : text.replace(' ', 'T');
  normalized = normalized.replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(normalized)) normalized = `${normalized}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

// loadObservations 取该平台最近一批观测（按 external_id 取最新一条）。
// accountId 有值时只取该账号的观测：同平台多个账号时，别把另一个账号的读数
// 算进本次对照，也不要让"缺观测"被别的账号的数据掩盖。
function loadObservations(platform, accountId) {
  const source = platform === 'xhs' ? 'xhs_browser' : 'wechat_browser';
  const scope = accountId ? ` AND o.account_id='${accountId}'` : '';
  const rows = query(`SELECT DISTINCT ON (external_id) external_id, values, quality_state,
      observed_at,
      (SELECT count(*) FROM platform_metric_observation o2
       WHERE o2.external_id=o.external_id AND o2.source=o.source) AS total_rows
    FROM platform_metric_observation o
    WHERE source='${source}'${scope}
    ORDER BY external_id, created_at DESC`);
  const out = new Map();
  for (const row of rows) {
    const [externalId, values, quality, observedAt, totalRows] = row;
    let parsed = {};
    try { parsed = JSON.parse(values); } catch { parsed = {}; }
    // observed_at 必须带出来：平台读数是会涨的，拿几小时前的观测和此刻的页面比，
    // 差 1~2 就是"采集之后又涨了"，不是"采集错了"。不带时间的话两种结论长得一样。
    const at = observedAt ? parseDbTimestamp(observedAt) : null;
    out.set(externalId, {
      values: parsed,
      quality,
      totalRows: Number(totalRows) || 1,
      observedAt: at
    });
  }
  return out;
}

// loadBoundWorks 取该平台已精确绑定且已发布的作品数（验收的"应有样本量"）。
// accountId 有值时按账号过滤：同一平台有两个小红书账号时，平台侧读的是 A 账号，
// 绑定数却混进 B 账号的作品，报告会说"已绑定 1 篇"而实际是 0 篇（2026-10-22 实测踩到）。
function loadBoundWorks(platform, accountId) {
  const column = platform === 'xhs' ? 'xhs_note_id' : 'wechat_msgid';
  const scope = accountId ? ` AND account_id='${accountId}'` : '';
  const rows = query(`SELECT count(*), count(DISTINCT date(published_at))
    FROM work WHERE ${column} IS NOT NULL AND deleted_at IS NULL AND published_at IS NOT NULL
      AND platform_binding_source IN ('user_link','user_confirm','official_exact')${scope}`);
  const [count, days] = rows[0] || ['0', '0'];
  return { works: Number(count) || 0, publishDays: Number(days) || 0 };
}

// ---------- 平台读取 ----------

function profileDirFor(platform, accountId) {
  // 连接命名空间目录：登录态真正落盘的地方。
  // 这里按目录扫描定位，避免把 user/device ID 硬编码进来。
  //
  // **必须按 accountId 精确匹配**：同一台机器上可能有多个账号的 profile
  // （实测同时存在 3 个小红书 profile）。早期实现"选目录最大的那个"，
  // 会读到**别的账号**的作品列表——对照结果看起来正常，其实是张冠李戴。
  const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'OPS Desktop', 'platform-profiles', 'accounts');
  const fs = require('node:fs');
  let found = null;
  const candidates = [];
  for (const user of fs.readdirSync(base, { withFileTypes: true })) {
    if (!user.isDirectory()) continue;
    const platformRoot = path.join(base, user.name, platform);
    if (!fs.existsSync(platformRoot)) continue;
    for (const conn of fs.readdirSync(platformRoot, { withFileTypes: true })) {
      if (!conn.isDirectory()) continue;
      const candidate = path.join(platformRoot, conn.name, 'profile');
      if (!fs.existsSync(path.join(candidate, 'Default', 'Network', 'Cookies'))) continue;
      // 读 meta 里的 accountId，只认匹配的那一个。
      let metaAccountId = '';
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(platformRoot, conn.name, 'meta.json'), 'utf8'));
        metaAccountId = typeof meta.accountId === 'string' ? meta.accountId : '';
      } catch { metaAccountId = ''; }
      const size = dirSize(candidate);
      candidates.push({ dir: candidate, size, metaAccountId });
      if (accountId && metaAccountId === accountId) found = { dir: candidate, size };
    }
  }
  if (found) return found.dir;
  if (accountId) {
    // 指定了账号却找不到：明确报错，不要静默退回"最大的那个"。
    // 静默退回会让报告看起来正常，实际比的是另一个账号——比报错危险得多。
    const known = candidates.map((c) => c.metaAccountId || '(无归属)').join(', ');
    throw new Error(`找不到账号 ${accountId} 的本机登录态（现有：${known}）`);
  }
  // 未指定账号时才退回"最大的那个"，并在报告里提示这是启发式选择。
  candidates.sort((a, b) => b.size - a.size);
  return candidates.length ? candidates[0].dir : null;
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
async function readPlatform(platform, accountId) {
  const profileDir = profileDirFor(platform, accountId);
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
          // 平台侧的发布时间（`time` 字段）。用来判断有没有 §17.1 要求的近期新作，
          // 不要用本地作品的 published_at——那可能是占位时间。
          recordedAt: n.recordedAt ?? null,
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
        recordedAt: a.sentAt ?? null,
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

// parsePublishTime 解析平台侧的发布时间：小红书是 "2026-09-21 19:18:00"，
// 公众号是 sent_info.time（秒级时间戳或日期串）。解析不了就返回 null——
// 宁可在报告里写"无法解析"，也不要拿本地占位时间充数。
function parsePublishTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{10}$/.test(text) || /^\d{13}$/.test(text)) return parsePublishTime(Number(text));
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d;
}

// freshnessOf 按平台发布时间判断 §17.1 要求的"近期新作"：最新一篇距今几天、D1/D3/D7 各几篇。
function freshnessOf(published) {
  const now = Date.now();
  const dated = [];
  let undated = 0;
  for (const item of published) {
    const at = parsePublishTime(item.recordedAt);
    if (!at) { undated += 1; continue; }
    dated.push({ at, days: Math.floor((now - at.getTime()) / 86_400_000) });
  }
  const newest = dated.reduce((acc, cur) => (acc === null || cur.at > acc.at ? cur : acc), null);
  return {
    dated: dated.length,
    undated,
    newestDays: newest ? newest.days : null,
    newestAt: newest ? newest.at.toISOString() : null,
    d1: dated.filter((d) => d.days <= 1).length,
    d3: dated.filter((d) => d.days <= 3).length,
    d7: dated.filter((d) => d.days <= 7).length
  };
}

// loadGrowthHistory 取某篇作品某字段的历史观测值（按时间升序，最近 6 条）。
// 只有一个用途：当"平台读数 > 观测"时，用历史判断这到底是"采集后涨了"还是"我们记错了"。
// 计数器只会单调不减；如果历史是一路涨上来的，那这次差值就是继续涨，不是记错。
// 如果历史里出现过下降，说明这个字段不是单调计数器，那就不能拿"会涨"来解释。
function loadGrowthHistory(platform, accountId, externalId, key) {
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(externalId)) return null;
  if (!/^[a-z_]{1,32}$/.test(key)) return null;
  const source = platform === 'xhs' ? 'xhs_browser' : 'wechat_browser';
  const scope = accountId ? ` AND account_id='${accountId}'` : '';
  const rows = query(`SELECT values->'${key}'->>'value'
    FROM platform_metric_observation
    WHERE source='${source}' AND external_id='${externalId}'${scope}
    ORDER BY observed_at DESC LIMIT 6`);
  const values = rows
    .map((r) => Number(r[0]))
    .filter((n) => Number.isFinite(n))
    .reverse();
  if (values.length < 2) return null;
  const monotonic = values.every((v, i) => i === 0 || v >= values[i - 1]);
  return { values, monotonic };
}

function compare(platform, platformItems, observations, accountId) {
  const rows = [];
  let matched = 0;
  let mismatched = 0;
  let missingObservation = 0;
  // grewCount：不一致里"平台读数比观测大"的条数。平台的计数只会涨，
  // 观测又是几小时前采的，所以这类差值可能是"采集之后涨的"，不是"采错了"。
  // 注意：这里**不因此判定为一致**——判定的唯一办法是重新采集后再对照，
  // 工具只负责把可解释性标出来，不负责把不一致改成一致。
  let grewCount = 0;
  const now = Date.now();
  for (const item of platformItems) {
    const obs = observations.get(item.externalId);
    if (!obs) {
      missingObservation += 1;
      rows.push({ externalId: item.externalId, status: item.status, fields: [], note: '无观测' });
      continue;
    }
    const observedAt = obs.observedAt || null;
    const ageMinutes = observedAt ? Math.max(0, Math.round((now - observedAt.getTime()) / 60_000)) : null;
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
      const grew = verdict === 'mismatch'
        && typeof platformValue === 'number'
        && typeof obsValue === 'number'
        && platformValue > obsValue;
      if (grew) grewCount += 1;
      // 只有"平台更大"的差值才去查历史：平台更小不可能是增长，
      // 那要么是我们记多了，要么平台回调了，都必须当问题看。
      const history = grew ? loadGrowthHistory(platform, accountId, item.externalId, key) : null;
      fields.push({
        key, label: FIELD_LABELS[key] || key, platformValue, obsValue, unit, precision, verdict, grew, history
      });
    }
    rows.push({
      externalId: item.externalId, status: item.status, fields, note: '', observedAt, ageMinutes
    });
  }
  return { rows, matched, mismatched, missingObservation, grewCount };
}

// ---------- 输出 ----------

function maskAccount(key) {
  if (!key) return '(未知)';
  const [kind, value] = key.split(':');
  if (!value) return key;
  return `${kind}:${value.slice(0, 8)}…`;
}

// growthHint 把一个"平台读数更大"的差值翻译成人话，并给出复核动作。
// 只解释、不判分：报告里这条仍然算不一致，验收仍然不通过。
// 三种情况分开写，是因为处置方式不同：
//   - 历史单调递增 → 这个字段本来就是计数器，先重采再对照；
//   - 历史出现过下降 → 不是单调计数器，不能拿"会涨"解释，要当记错查；
//   - 历史不足两条 → 没有依据，只能重采。
function growthHint(field) {
  if (!field.grew) return '';
  const history = field.history;
  if (!history) return ' ← 平台读数更大，且历史不足两条，无法判断；需重采后再对照';
  if (!history.monotonic) {
    return ` ← 平台读数更大，但历史出现过下降（${history.values.join(' → ')}），不能用"增长"解释，需按记错排查`;
  }
  return ` ← 平台读数更大；历史单调递增（${history.values.join(' → ')}），像是采集后增长，需重采后再对照`;
}

function printReport(platform, reading, obsResult, bound, options) {
  const { rows, matched, mismatched, missingObservation, grewCount } = obsResult;
  const published = reading.items.filter((i) => i.status === 'published');
  const deleted = reading.items.filter((i) => i.status === 'deleted');
  const fieldsTotal = rows.reduce((sum, r) => sum + r.fields.length, 0);
  const fresh = freshnessOf(published);
  // 豁免不是"算达标"，而是"这一条不参与判定"。两者必须分开表达：
  // 报告若把豁免项打成 ✓，后来的人会以为 D1/D3/D7 真的验过了。
  const freshnessWaived = options.waiveFreshness === true;
  const freshEnough = fresh.newestDays !== null && fresh.newestDays <= 7;

  if (options.json) {
    console.log(JSON.stringify({
      platform, landed: reading.landed, coverage: reading.coverage,
      bound, publishedCount: published.length, deletedCount: deleted.length,
      matched, mismatched, missingObservation, grewCount, fieldsTotal, freshness: fresh,
      freshnessWaived, rows
    }, null, 2));
    return { matched, mismatched };
  }

  console.log(`\n=== ${platform === 'xhs' ? '小红书' : '公众号'} 验收对照 ===`);
  console.log(`落点        ${reading.landed.slice(0, 70)}`);
  if (options.accountId) {
    console.log(`账号        ${options.accountId}（绑定与观测均已按该账号过滤）`);
  }
  console.log(`平台作品    ${reading.items.length} 条（已发布 ${published.length}、已删除 ${deleted.length}）`);
  console.log(`已绑定作品  ${bound.works} 篇，跨 ${bound.publishDays} 个发布日`);
  console.log(`对照结果    一致 ${matched}、不一致 ${mismatched}、缺观测 ${missingObservation}`);
  if (grewCount > 0) {
    // 这一行不是"洗白"，是提示复核顺序：先重新采一次再对照，差值消失就是增长。
    console.log(`            其中 ${grewCount} 项是"平台读数大于观测"——平台计数会涨，需先重采再判定`);
  }
  console.log(`覆盖        ${JSON.stringify(reading.coverage)}`);
  if (fresh.newestDays === null) {
    console.log(`新作        无法从平台解析发布时间（${fresh.dated}/${published.length} 篇有日期）✗`);
  } else {
    const mark = freshnessWaived ? '已豁免' : freshEnough ? '✓' : '✗';
    console.log(
      `新作        最新一篇距今 ${fresh.newestDays} 天（${fresh.newestAt.slice(0, 10)}），` +
      `D1 ${fresh.d1} 篇 / D3 ${fresh.d3} 篇 / D7 ${fresh.d7} 篇 ${mark}` +
      (fresh.undated ? `（另有 ${fresh.undated} 篇无发布时间）` : '')
    );
    if (freshnessWaived) {
      // 必须打印豁免来源：否则下一个人只看数字，会以为这条达标了。
      console.log('            豁免依据：docs/21 十七点三十三（用户 2026-10-22 书面豁免）');
    }
  }

  const bad = rows.filter((r) => r.fields.some((f) => f.verdict === 'mismatch' || f.verdict === 'obs_missing'));
  // "无观测"的作品没有字段可比，不能因为它在 bad 里筛不出来就打印"全部一致"——
  // 那会把"10 篇一条观测都没有"读成"10 篇全部对上"。
  const missingRows = rows.filter((r) => r.fields.length === 0);
  if (bad.length === 0 && missingRows.length === 0) {
    console.log('\n逐字段对照：全部一致。');
  } else {
    console.log('\n逐字段对照（仅列出不一致与无观测项）：');
    for (const r of missingRows) {
      console.log(`  ${r.externalId}  无观测：该作品还没有采集结果`);
    }
    for (const r of bad) {
      // 观测时间必须打出来：没有它，"平台=645 观测=644"这种差值无法判断是
      // "采错了"还是"采集之后涨了 1"，而这两者的处置完全不同。
      const stamp = r.observedAt
        ? `（观测于 ${r.observedAt.toISOString().slice(0, 16).replace('T', ' ')}Z，${r.ageMinutes} 分钟前）`
        : '（观测时间未知）';
      console.log(`  ${r.externalId}${stamp}`);
      for (const f of r.fields) {
        if (f.verdict === 'mismatch' || f.verdict === 'obs_missing') {
          console.log(`    ${f.label}: 平台=${f.platformValue} 观测=${f.obsValue} (${f.verdict}, unit=${f.unit})${growthHint(f)}`);
        }
      }
    }
  }

  // 每字段有效对照数：按**作品**去重，不是按观测条数。
  // §17.1 要求"每字段至少 10 个有效对照"——同一篇作品的多次采集只算一个对照，
  // 否则重复采集会把数字刷上去，看起来达标其实样本只有几篇。
  // 还要求**两侧都有值**：平台有读数、观测里没这个字段时不算对照——
  // 早期实现只看平台侧非空，观测缺字段也能把计数堆到 10，达标是假的。
  const perField = new Map();
  for (const r of rows) {
    for (const f of r.fields) {
      if (f.platformValue === null || f.platformValue === undefined) continue;
      if (f.obsValue === null || f.obsValue === undefined) continue;
      perField.set(f.label, (perField.get(f.label) ?? 0) + 1);
    }
  }
  const fieldRows = [...perField.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n每字段有效对照（按作品去重）：');
  if (fieldRows.length === 0) {
    console.log('  （暂无观测，没有可计的对照）');
  }
  for (const [label, count] of fieldRows) {
    console.log(`  ${label.padEnd(6)} ${String(count).padStart(2)} 篇 ${count >= 10 ? '✓' : '✗ 不足 10'}`);
  }

  // 样本量是否达标（§17.1 要求 ≥10 篇、≥3 个发布日、**每字段** ≥10 个对照，且有近期新作）。
  // 豁免项不参与判定，但在明细里显示"已豁免"，不显示 ✓——避免把豁免读成达标。
  const worksEnough = published.length >= 10;
  const daysEnough = bound.publishDays >= 3;
  const fieldsEnough = fieldRows.length > 0 && fieldRows.every(([, count]) => count >= 10);
  const freshGate = freshnessWaived || freshEnough;
  const enough = worksEnough && daysEnough && fieldsEnough && freshGate;
  const freshLabel = freshnessWaived ? '已豁免' : freshEnough ? '✓' : '✗';
  console.log(
    `\n样本量      ${enough ? '达标' : '不达标'}` +
    `（篇数 ${published.length}/10 ${worksEnough ? '✓' : '✗'}，` +
    `发布日 ${bound.publishDays}/3 ${daysEnough ? '✓' : '✗'}，` +
    `每字段 ≥10 ${fieldsEnough ? '✓' : '✗'}，` +
    `近 7 天新作 ${freshLabel}）`
  );
  if (freshnessWaived && !freshEnough) {
    console.log('            注：豁免只免除"近期新作"这一条，其余门槛照常判定。');
  }
  return { matched, mismatched, enough };
}

// ---------- 主流程 ----------

async function main() {
  const platform = process.argv[2];
  // --account <uuid>：指定要对照的 OPS 账号。**强烈建议总是传**——
  // 同一台机器可能有多个账号的登录态，不传只能按目录大小猜。
  const accIdx = process.argv.indexOf('--account');
  const rawAccountId = accIdx > 0 ? process.argv[accIdx + 1] : undefined;
  const options = {
    json: process.argv.includes('--json'),
    accountId: rawAccountId === undefined ? undefined : assertAccountId(rawAccountId),
    // --waive-freshness：用户已书面豁免"近 7 天新作"（docs/21 十七点三十三）。
    // 必须显式传，不设默认值——默认豁免等于把门槛悄悄拆了。
    waiveFreshness: process.argv.includes('--waive-freshness')
  };
  if (platform !== 'xhs' && platform !== 'wechat_mp') {
    console.error('用法：node tools/platform-acceptance.cjs <xhs|wechat_mp> [--account <uuid>] [--json] [--waive-freshness]');
    process.exit(2);
  }
  const observations = loadObservations(platform, options.accountId);
  const bound = loadBoundWorks(platform, options.accountId);
  let reading;
  try {
    reading = await readPlatform(platform, options.accountId);
  } catch (error) {
    console.error(`读取平台失败：${error.code || ''} ${error.message}`);
    process.exit(1);
  }
  const result = compare(platform, reading.items, observations, options.accountId);
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
