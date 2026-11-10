'use strict';
// DT-08 片 8（docs/33 §10.8 DT-08；≡DEV-S02）：main.ts 的 inbrowse:* 通道拆分。
// 14 个内置浏览视图固定意图（set-bounds/navigate/back/forward/reload/stop/open-tab/
// switch-tab/reorder-tab/close-tab/close/snapshot/data-stats/clear-data）搬入
// ipc/inbrowse.ts；requireInBrowse 来源校验（业务窗主框架 + bindInBrowseController）
// 留 main.ts 依赖注入。契约与返回值形状逐字节不变。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('DT-08-8: ipc/inbrowse.ts 存在且承载全部 14 个 inbrowse 通道', () => {
  const inbrowseSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'inbrowse.ts'), 'utf8');
  for (const channel of ['inbrowse:set-bounds', 'inbrowse:navigate', 'inbrowse:back', 'inbrowse:forward',
    'inbrowse:reload', 'inbrowse:stop', 'inbrowse:open-tab', 'inbrowse:switch-tab', 'inbrowse:reorder-tab',
    'inbrowse:close-tab', 'inbrowse:close', 'inbrowse:snapshot', 'inbrowse:data-stats', 'inbrowse:clear-data']) {
    assert.ok(inbrowseSource.includes(`ipcHandle('${channel}'`), `inbrowse.ts 应注册 ${channel}`);
  }
});

test('DT-08-8: main.ts 不再内联 inbrowse 通道（校验器与快照推送闭包留 main）', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.ok(!mainSource.includes("ipcHandle('inbrowse:set-bounds'"), 'set-bounds 应已迁出 main.ts');
  assert.ok(!mainSource.includes("ipcHandle('inbrowse:clear-data'"), 'clear-data 应已迁出 main.ts');
  assert.ok(mainSource.includes('requireInBrowse'), 'requireInBrowse 校验器应留 main.ts（依赖注入）');
  assert.ok(mainSource.includes('desktop-ui:inbrowse-snapshot'), '快照推送闭包应留 main.ts');
});

test('DT-08-8: 防线语义逐字节保留（bounds 形状/navigate 拒绝/清数据类别白名单）', () => {
  const inbrowseSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'inbrowse.ts'), 'utf8');
  assert.ok(inbrowseSource.includes("throw new Error('bounds 参数无效。')"), 'bounds 参数校验保留');
  assert.ok(inbrowseSource.includes('inbrowse_navigate_denied'), '导航拒绝错误码保留');
  assert.ok(inbrowseSource.includes("throw new Error('inbrowse_data_kind_invalid')"), '清数据类别白名单保留');
  assert.ok(inbrowseSource.includes('inbrowse_reorder_invalid'), '重排校验保留');
});
