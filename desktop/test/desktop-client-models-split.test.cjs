'use strict';
// DT-08 片 6（docs/33 §10.8 DT-08）：desktop-client.ts 模型/路由域拆分。
// saveModel/deleteModel/listModels/toPublicModel/applyMode/restoreAppliedMode/routes
// 系列（约 350 行）搬到 client/models.ts 的 ModelsMixin；façade 继承。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('DT-08B: client/models.ts 存在且承载模型/路由方法', () => {
  const modelsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'models.ts'), 'utf8');
  for (const symbol of ['saveModel(', 'deleteModel(', 'applyMode(', 'restoreAppliedMode(', 'listDesktopRoutes(', 'saveDesktopRoutes(', 'toPublicModel(']) {
    assert.ok(modelsSource.includes(symbol), `models.ts 应包含 ${symbol}`);
  }
});

test('DT-08B: DesktopClient 继承 ModelsMixin，desktop-client.ts 不再内联模型方法体', () => {
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-client.ts'), 'utf8');
  assert.ok(clientSource.includes('ModelsMixin'), 'DesktopClient 应继承 ModelsMixin');
  assert.ok(!clientSource.includes('async saveModel(input: SaveModelInput)'), 'saveModel 应已迁出');
  assert.ok(!clientSource.includes('async restoreAppliedMode('), 'restoreAppliedMode 应已迁出');
});

test('DT-08B: 模型域防线消息保留（本机模型校验与代理文案）', () => {
  const modelsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'models.ts'), 'utf8');
  assert.ok(modelsSource.includes('图片 CDN 域名最多只能设置 50 个。'), 'allowedImageHosts 上限防线保留');
  assert.ok(modelsSource.includes('代理用户名和密码必须同时填写，且不能包含换行。'), '保存时代理字段校验保留（resolveModelProxy 的运行时校验在 channel.ts，由 DT-08A 契约覆盖）');
});
