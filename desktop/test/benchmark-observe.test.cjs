const assert = require('node:assert/strict');
const test = require('node:test');

const {
  benchmarkURLAllowed,
  discoverNoteURL,
  externalIDForPublicURL,
  failedPublicNote,
  metricsFromLabeledCounts,
  metricsFromText,
  noteIDFromPublicURL,
  parsePublicCount,
  parsePublicNoteSnapshot
} = require('../.build/benchmark-observe.js');

function snapshot(overrides = {}) {
  return {
    finalUrl: 'http://127.0.0.1:8287/__e2e/benchmark/public/profile',
    title: '公开主页样本 - 小红书',
    meta: {},
    globals: {},
    links: [],
    text: '',
    ...overrides
  };
}

test('公开 URL：只接受平台域名，本地样本仅在 allowLocal 时放行', () => {
  assert.equal(benchmarkURLAllowed('xhs', 'https://www.xiaohongshu.com/explore/abc', false), true);
  assert.equal(benchmarkURLAllowed('xhs', 'https://xiaohongshu.com.evil.example/explore/abc', false), false);
  assert.equal(benchmarkURLAllowed('toutiao', 'https://www.toutiao.com/article/123/', false), true);
  assert.equal(benchmarkURLAllowed('wechat_mp', 'https://mp.weixin.qq.com/s/abc', false), true);
  assert.equal(benchmarkURLAllowed('xhs', 'http://127.0.0.1:8287/__e2e/benchmark/public/profile', false), false);
  assert.equal(benchmarkURLAllowed('xhs', 'http://127.0.0.1:8287/__e2e/benchmark/public/profile', true), true);
  assert.equal(benchmarkURLAllowed('xhs', 'https://user:pass@www.xiaohongshu.com/explore/abc', false), false);
});

test('主页快照能发现作品链接，作品 URL 能取出 external_id', () => {
  const profile = snapshot({
    links: [
      'http://127.0.0.1:8287/__e2e/benchmark/public/note/e2e-note-1',
      'https://www.xiaohongshu.com/user/profile/other'
    ]
  });
  assert.equal(discoverNoteURL(profile, 'xhs'), 'http://127.0.0.1:8287/__e2e/benchmark/public/note/e2e-note-1');
  assert.equal(noteIDFromPublicURL(profile.links[0], 'xhs'), 'e2e-note-1');
  assert.equal(noteIDFromPublicURL('https://www.xiaohongshu.com/explore/6f0000000000000000000001?xsec_token=a', 'xhs'),
    '6f0000000000000000000001');
  assert.equal(noteIDFromPublicURL('https://www.toutiao.com/article/7400000000000000000/', 'toutiao'),
    '7400000000000000000');
  assert.equal(externalIDForPublicURL('https://mp.weixin.qq.com/s/example-article', 'wechat_mp'), 'example-article');
});

test('公开作品 JSON：标题、发布时间、五项指标完整解析为 ok', () => {
  const note = parsePublicNoteSnapshot(snapshot({
    finalUrl: 'http://127.0.0.1:8287/__e2e/benchmark/public/note/e2e-note-1',
    title: 'I1 公开页只读样本 - 小红书',
    meta: { 'og:title': 'I1 公开页只读样本', 'article:published_time': '2026-11-10T09:12:00+08:00' },
    globals: {
      __INITIAL_STATE__: {
        note: {
          noteId: 'e2e-note-1',
          title: 'I1 公开页只读样本',
          time: 1762737120000,
          interactInfo: { likedCount: 21, commentCount: '3', collectedCount: '8', shareCount: '1', viewCount: 120 }
        }
      }
    },
    text: '21 赞 · 3 评论 · 8 收藏 · 1 分享 · 120 浏览'
  }), 'xhs', 'http://127.0.0.1:8287/__e2e/benchmark/public/note/e2e-note-1');

  assert.equal(note.externalId, 'e2e-note-1');
  assert.equal(note.title, 'I1 公开页只读样本');
  assert.equal(note.quality, 'ok');
  assert.deepEqual(note.values, { likes: 21, comments: 3, favorites: 8, shares: 1, views: 120 });
  assert.equal(note.publishedAt, '2026-11-10T01:12:00.000Z');
  assert.equal(note.url, 'http://127.0.0.1:8287/__e2e/benchmark/public/note/e2e-note-1');
});

test('只有单个指标时如实写 partial，不把缺失指标补成 0', () => {
  const note = parsePublicNoteSnapshot(snapshot({
    finalUrl: 'https://www.xiaohongshu.com/explore/abc123',
    title: '只有点赞',
    globals: { __INITIAL_STATE__: { note: { noteId: 'abc123', interactInfo: { likedCount: 9 } } } },
    text: '9 赞'
  }), 'xhs', 'https://www.xiaohongshu.com/explore/abc123');
  assert.equal(note.quality, 'partial');
  assert.deepEqual(note.values, { likes: 9 });
  assert.equal(note.publishedAt, null);
});

test('登录墙/风控页不解析指标，统一 failed 且 values 为空', () => {
  const login = parsePublicNoteSnapshot(snapshot({
    finalUrl: 'https://www.xiaohongshu.com/explore/abc123',
    text: '请先登录后查看笔记内容',
    globals: { __INITIAL_STATE__: { likes: 999 } }
  }), 'xhs', 'https://www.xiaohongshu.com/explore/abc123');
  assert.equal(login.quality, 'failed');
  assert.equal(login.errorCode, 'login_wall');
  assert.deepEqual(login.values, {});

  const risk = failedPublicNote('https://www.toutiao.com/article/123/', 'toutiao', '风控页', 'risk_control');
  assert.equal(risk.quality, 'failed');
  assert.deepEqual(risk.values, {});
  assert.equal(risk.externalId, '123');
});

test('主页没有公开作品链接时 failed(no_public_note)，不伪造观测', () => {
  const note = parsePublicNoteSnapshot(snapshot({
    finalUrl: 'https://www.xiaohongshu.com/user/profile/abc',
    links: []
  }), 'xhs', 'https://www.xiaohongshu.com/user/profile/abc');
  assert.equal(note.quality, 'failed');
  assert.equal(note.errorCode, 'no_public_note');
  assert.deepEqual(note.values, {});
});

test('万/亿单位与可见文本兜底', () => {
  assert.equal(parsePublicCount('1.2万'), 12000);
  assert.equal(parsePublicCount('3.4w'), 34000);
  assert.equal(parsePublicCount('10万+'), 100000);
  assert.equal(parsePublicCount('-1'), null);
  assert.deepEqual(metricsFromText('1.2万 点赞 · 345 评论 · 678 收藏'), { likes: 12000, comments: 345, favorites: 678 });
});

test('头条移动公开页的 aria-label 计数与可见日期可解析为 ok', () => {
  assert.deepEqual(metricsFromLabeledCounts([
    { label: '125评论', text: '125' },
    { label: '点赞', text: '360' },
    { label: '分享', text: '分享' },
    { label: '收藏', text: '收藏' }
  ]), { comments: 125, likes: 360 });

  const note = parsePublicNoteSnapshot(snapshot({
    finalUrl: 'https://m.toutiao.com/article/7444062811845689865/',
    title: '今日头条上线官方媒体信源关联功能 - 今日头条',
    labeledCounts: [
      { label: '125评论', text: '125' },
      { label: '点赞', text: '360' }
    ],
    text: '头条号平台官方账号\n 2024-12-3 14:08\n分享\n125\n360\n收藏'
  }), 'toutiao', 'https://m.toutiao.com/article/7444062811845689865/');

  assert.equal(note.externalId, '7444062811845689865');
  assert.equal(note.title, '今日头条上线官方媒体信源关联功能');
  assert.equal(note.quality, 'ok');
  assert.deepEqual(note.values, { comments: 125, likes: 360 });
  assert.equal(note.publishedAt, '2024-12-03T06:08:00.000Z');
});
