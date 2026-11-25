import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');

async function readSource(relative) {
  // 仓库工作区是 CRLF，断言里需要跨行匹配，统一成 LF 再读。
  return fs.readFile(path.join(rendererRoot, relative), 'utf8').then((text) => text.replace(/\r\n/g, '\n'));
}

const count = (source, token) => source.split(token).length - 1;

// OPT-U05（docs/43 §4）：复盘页截图拖拽 / Ctrl+V 粘贴识图升级，只复用既有接口。
// 1) 三种入口（选择文件 / 拖拽 / 粘贴）共用 ensureModelReady + handleIncomingFiles，识别仍走
//    POST /accounts/{id}/metrics/screenshots，导出入仍走 POST /metrics/screenshots/{id}/rows/{idx}/confirm；
// 2) 拖拽、粘贴都要拦非 PNG/JPEG 与超过 9 张，且粘贴绝不抢占输入框 / 打开中的弹窗；
// 3) DEV-DR05 红线不变：逐行「导入这一行」，没有任何「全部导入」按钮或批量接口。

test('截图识图：dropzone 变体 + 拖拽事件 + 粘贴监听都是可选增强，既有按钮调用保持默认', async () => {
  const source = await readSource('pages/review-screenshots.tsx');
  // 变体与开关默认值：既有 3 处调用（Review.tsx）不传这些 props 也不会改变行为。
  assert.match(source, /variant = 'button'/);
  assert.match(source, /variant\?: 'button' \| 'dropzone'/);
  assert.match(source, /enableWindowPaste = false/);
  assert.match(source, /enableWindowPaste\?: boolean/);
  assert.match(source, /highlightHint\?: string/);
  assert.match(source, /variant === 'dropzone' \? \(/);
  // 引导卡：固定 testid + 四个拖拽事件，拖拽中要高亮（不是静态装饰）。
  assert.ok(source.includes('data-testid="review-screenshot-dropzone"'));
  assert.match(source, /onDragOver=\{onDragOver\}/);
  assert.match(source, /onDragEnter=\{onDragEnter\}/);
  assert.match(source, /onDragLeave=\{onDragLeave\}/);
  assert.match(source, /onDrop=\{onDrop\}/);
  assert.match(source, /const dragDepth = useRef\(0\)/);
  assert.match(source, /event\.dataTransfer\.dropEffect = 'copy'/);
  assert.match(source, /data-dragging=\{dragging \? 'true' : 'false'\}/);
  assert.match(source, /ring-2 ring-ink-200/);
  // 卡片内的按钮名不能与 PageHeader 的「截图识别」重名，否则 e2e 的角色查询会二选一。
  assert.match(source, />选择截图文件<\/Button>/);
  assert.equal(count(source, 'label="截图识别"'), 0);
  assert.match(source, /正在识别截图数据…/);
  assert.match(source, /截图粘贴 \/ 拖拽一键识图录入/);
  assert.match(source, /无「全部导入」/);
});

test('截图识图：拖拽 / 粘贴 / 选文件共用同一套前置校验与文件过滤', async () => {
  const source = await readSource('pages/review-screenshots.tsx');
  // 模型前置校验抽成公共函数，三条入口都先 await 它；原 Toast 与 vision_route 确认弹窗原样保留。
  assert.match(source, /const ensureModelReady = async \(\) => \{/);
  assert.match(source, /if \(ai && !ai\.ready\)/);
  assert.match(source, /还没有配置模型/);
  assert.match(source, /if \(ai && !ai\.vision_route && !\(await confirm\(\{/);
  assert.match(source, /confirmText: '仍要上传'/);
  assert.equal(count(source, 'await ensureModelReady()'), 2);
  assert.match(source, /const pick = async \(\) => \{\n    if \(!\(await ensureModelReady\(\)\)\) return\n    input\.current\?\.click\(\)/);
  // 选文件的模型校验只在 pick() 里做一次：onChange 带 skipModelCheck=true，否则无 vision_route 会连弹两次确认框。
  assert.match(source, /const handleIncomingFiles = async \(rawFiles: File\[\], skipModelCheck = false\) => \{/);
  assert.match(source, /if \(!skipModelCheck && !\(await ensureModelReady\(\)\)\) return\n    void recognize\(valid\)/);
  // 并发保护：识别中或核对弹窗未关闭时，拖拽 / 粘贴直接忽略。
  assert.match(source, /if \(busy \|\| !!upload\) return/);
  assert.match(source, /const liveRef = useRef\(\{ busy, upload, handle: handleIncomingFiles \}\)/);
  assert.match(source, /useEffect\(\(\) => \{ liveRef\.current = \{ busy, upload, handle: handleIncomingFiles \} \}\)/);
  // 文件过滤：PNG/JPEG 大小写兼容 + 丢 MIME 时回落 .png/.jpg/.jpeg 文件名，webp 等一律拒绝。
  assert.match(source, /const isSupportedShot = \(file: File\) => \{/);
  assert.match(source, /const mime = \(file\.type \|\| ''\)\.toLowerCase\(\)/);
  assert.match(source, /if \(mime === 'image\/png' \|\| mime === 'image\/jpeg'\) return true/);
  assert.ok(source.includes('(png|jpg|jpeg)$/i.test(file.name'));
  assert.match(source, /const valid = rawFiles\.filter\(isSupportedShot\)/);
  assert.match(source, /仅支持 PNG \/ JPEG 格式截图，请重新截取或转换后再试/);
  assert.equal(count(source, '仅支持 PNG / JPEG 格式截图，请重新截取或转换后再试'), 2);
  assert.match(source, /if \(!valid\.length\) \{/);
  // 9 张上限沿用原提示，且依然在真正发请求前拦下。
  assert.match(source, /const MAX_SHOTS = 9/);
  assert.match(source, /if \(valid\.length > MAX_SHOTS\) \{/);
  assert.ok(source.includes('toast.error(`一次最多识别 ${MAX_SHOTS} 张截图`)'));
  assert.equal(count(source, '一次最多识别 ${MAX_SHOTS} 张截图'), 2);
  // 选择文件也要走统一入口，不再绕过校验直连 recognize；但模型确认只由 pick() 弹一次。
  assert.match(source, /if \(fs\.length\) void handleIncomingFiles\(fs, true\)/);
  assert.equal(count(source, 'handleIncomingFiles(fs, true)'), 1);
  // 拖拽与粘贴仍保持默认严格校验（不传 skipModelCheck）。
  assert.match(source, /void handleIncomingFiles\(Array\.from\(event\.dataTransfer\?\.files \?\? \[\]\)\)/);
  assert.match(source, /void live\.handle\(images\)/);
  assert.equal(count(source, 'handleIncomingFiles(Array.from(event.dataTransfer?.files ?? []), true)'), 0);
  assert.match(source, /accept="image\/png,image\/jpeg"/);
});

test('截图识图：window paste 只在显式开关下监听，输入框 / 弹窗内不抢占，纯文本不拦截', async () => {
  const source = await readSource('pages/review-screenshots.tsx');
  assert.match(source, /if \(!enableWindowPaste\) return/);
  assert.match(source, /window\.addEventListener\('paste', onPaste\)/);
  assert.match(source, /return \(\) => window\.removeEventListener\('paste', onPaste\)/);
  assert.match(source, /\}, \[enableWindowPaste\]\)/);
  // 焦点保护：input / textarea / contenteditable / 任意打开中的 dialog（粘贴回填、录入抽屉、核对弹窗）。
  assert.match(source, /el\.closest\('input, textarea, \[contenteditable="true"\]'\)/);
  assert.match(source, /el\.closest\('\[role="dialog"\]'\)/);
  assert.match(source, /if \(editing\(event\.target\) \|\| editing\(document\.activeElement\)\) return/);
  // 剪贴板两个来源都读，按 name|size|lastModified 去重，避免 files 与 items 重复算成两张。
  assert.match(source, /Array\.from\(data\.items \?\? \[\]\)\.forEach\(\(item\) => \{ if \(item\.kind === 'file' && item\.type\.startsWith\('image\/'\)\) add\(item\.getAsFile\(\)\) \}\)/);
  assert.match(source, /Array\.from\(data\.files \?\? \[\]\)\.forEach\(add\)/);
  assert.match(source, /const key = `\$\{file\.name\}\|\$\{file\.size\}\|\$\{file\.lastModified\}`/);
  assert.match(source, /if \(seen\.has\(key\)\) return/);
  // 纯文本粘贴必须直接放过：没有图片时 return 在 preventDefault 之前。
  assert.ok(source.indexOf('if (!images.length) return') < source.indexOf('event.preventDefault()'));
  assert.match(source, /void live\.handle\(images\)/);
  assert.match(source, /if \(live\.busy \|\| !!live\.upload\) return/);
});

test('截图识图：只走既有截图接口，逐行核对与「导入这一行」红线原样保留', async () => {
  const source = await readSource('pages/review-screenshots.tsx');
  // 识别与确认接口都是既有实现，没有新增路由。
  assert.ok(source.includes('`/accounts/${accountId}/metrics/screenshots`'));
  assert.ok(source.includes('`/metrics/screenshots/${upload.id}/rows/${i}/confirm`'));
  assert.doesNotMatch(source, /screenshots\/batch|screenshots\/all|rows\/all|confirmAll|importAll|handleAllShots/);
  assert.doesNotMatch(source, /全部导入<\/Button>|一键导入|批量导入|全部确认/);
  // 逐行核对弹窗、左图右表、头条累计值确认、7 天自动删除提示都还在。
  assert.match(source, /title="核对截图识别结果"/);
  assert.match(source, /对照左边的截图逐行核对，改对数字后点「导入这一行」；没导入的行不会保存。/);
  assert.match(source, /platform === 'toutiao' && upload\.rows\[i\]\?\.interval_hint && !d\.cumulativeConfirmed/);
  assert.match(source, /我已核对，并将本行数值改为截至采集时间的累计值/);
  assert.match(source, />导入这一行<\/Button>/);
  assert.match(source, /截图只用于识别数字，7 天后自动删除，不进素材库、不进 AI 记忆/);
  // 一次识别仍然只有一个请求，没有 for 循环逐张发请求。
  assert.equal(count(source, 'rawRequest(\'POST\', `/accounts/${accountId}/metrics/screenshots`'), 1);
});

test('复盘页：无 datacube / 小红书 / 未开自动同步时置顶 dropzone，PageHeader 的「截图识别」不变', async () => {
  const review = await readSource('pages/Review.tsx');
  // 门禁：只在可写角色 + 具体场景挂载引导卡，viewer 不出现写入口。
  assert.match(review, /const showScreenshotDropzone = canWrite && screenshotDropzoneReason !== ''/);
  assert.match(review, /acc\.platform === 'xhs' \? 'xhs'/);
  assert.match(review, /acc\.platform === 'wechat_mp' && acc\.datacube_state === 'no_permission' \? 'wechat_no_datacube'/);
  assert.match(review, /acc\.platform === 'wechat_mp' && !acc\.metrics_wechat_auto\?\.enabled \? 'wechat_no_auto'/);
  assert.ok(review.includes('当前公众号无数据统计接口权限，直接 Ctrl+V 粘贴或拖入后台数据截图即可识别录入'));
  assert.ok(review.includes('小红书创作者后台数据页截图可直接 Ctrl+V 粘贴或拖入识别，逐行核对后入库。'));
  assert.ok(review.includes('当前未开启自动同步，可直接 Ctrl+V 粘贴或拖入数据截图快速录入。'));
  // 挂载参数：dropzone 变体 + 窗口级粘贴，只有这一处开启，避免多实例并发识别。
  assert.match(review, /<ScreenshotImport variant="dropzone" enableWindowPaste accountId=\{acc\.id\} platform=\{acc\.platform\} works=\{rows\}/);
  assert.match(review, /highlightHint=\{screenshotHint\}/);
  assert.equal(count(review, 'enableWindowPaste'), 1);
  assert.match(review, /onDone=\{\(\) => \{ board\.refetch\(\); inv\(\['board'\]\); inv\(\['data-preferences', acc\.id\]\) \}\}/);
  assert.match(review, /\{showScreenshotDropzone && \(/);
  // 位置：桌面态在指标卡下方、看板标题上方；非桌面态也落在 #desktop-review-board 之前。
  const statsAt = review.indexOf('className="desktop-review-stats"');
  const slotAt = review.indexOf('data-testid="review-screenshot-dropzone-slot"');
  const headingAt = review.indexOf('className="desktop-review-board-heading"');
  const boardAt = review.indexOf('<Card className="mb-6 overflow-hidden" id="desktop-review-board">');
  assert.ok(statsAt > 0 && slotAt > statsAt && headingAt > slotAt && boardAt > slotAt);
  // 原有三处 ScreenshotImport 调用（绘制行 / PageHeader / 非桌面 CardHeader）全部保留，含 label="截图识别"。
  assert.equal(count(review, '<ScreenshotImport'), 4);
  assert.equal(count(review, 'label="截图识别"'), 1);
  assert.equal(count(review, 'label="上传截图识别"'), 1);
  // PageHeader 第 757 行原调用（含识别后刷新 data-preferences 的 onDone）逐字未改。
  assert.match(review,
    /<ScreenshotImport accountId=\{acc\.id\} platform=\{acc\.platform\} works=\{rows\} onDone=\{\(\) => \{ board\.refetch\(\); inv\(\['board'\]\); inv\(\['data-preferences', acc\.id\]\) \}\} label="截图识别" \/>/);
});
