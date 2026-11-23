// B-01.6：平台登录人工接管的本地提示页。
//
// 只生成一段静态 HTML，不依赖页面、不注入登录页 DOM、不加载扩展。
// 用户点击按钮后把 document.title 改成固定哨兵，主进程监听
// `page-title-updated` 得到 handoff_complete 信号；页面本身无法伪造这个点击。

export const HANDOFF_COMPLETE_TITLE = 'ops-handoff-complete';

export interface PlatformLoginHandoffPageInput {
  platform: string;
  vendor: string;
  kind: string;
  message: string;
  /** 平台登录页 origin，只用于展示来源，帮助用户确认自己点的是哪个站。 */
  origin?: string;
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildPlatformLoginHandoffHtml(input: PlatformLoginHandoffPageInput): string {
  const origin = input.origin ? escapeHtml(input.origin) : '当前平台登录窗口';
  const platform = escapeHtml(input.platform);
  const vendor = escapeHtml(input.vendor);
  const kind = escapeHtml(input.kind);
  const message = escapeHtml(input.message);
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>OPS 平台登录人工接管</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 18px 20px; font: 14px/1.5 "Microsoft YaHei", system-ui, sans-serif; color: #1f2937; background: #fff; }
  h1 { margin: 0 0 8px; font-size: 18px; }
  .meta { margin: 0 0 10px; color: #6b7280; font-size: 12px; }
  .msg { margin: 0 0 16px; padding: 10px 12px; background: #f3f4f6; border-radius: 8px; white-space: pre-wrap; }
  button { width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-size: 15px; cursor: pointer; }
  button:active { background: #1d4ed8; }
  .hint { margin-top: 10px; color: #6b7280; font-size: 12px; }
</style>
<body>
  <h1>需要人工完成验证</h1>
  <p class="meta">平台：${platform} · 来源：${origin} · 信号：${vendor}/${kind}</p>
  <p class="msg">${message}</p>
  <button id="done" type="button">我已完成，继续登录</button>
  <p class="hint">点击只表示你已在平台窗口完成操作；OPS 仍会以平台页面真实登录状态为准。</p>
  <script>
    document.getElementById('done').addEventListener('click', function () {
      document.title = '${HANDOFF_COMPLETE_TITLE}';
    });
  </script>
</body>
</html>`;
}
