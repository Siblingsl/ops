const origin = document.getElementById('origin');
const version = document.getElementById('version');
const aiStatus = document.getElementById('ai-status');
const actionStatus = document.getElementById('action-status');

window.opsDesktopSettings.getInfo().then((info) => {
  origin.textContent = info.apiOrigin;
  version.textContent = info.appVersion;
  aiStatus.textContent = info.aiStatus;
  if (info.failureReason === 'icp-block') {
    document.getElementById('lead').textContent = '服务器返回了阿里云 ICP 备案拦截页，业务页面未加载。请完成该域名备案并确认 HTTP 服务可访问，或改用可正常访问的 HTTP 业务地址后重试。';
  } else if (info.failureReason === 'render-failed') {
    document.getElementById('lead').textContent = '服务器已返回页面，但页面内容未能显示。请检查网络或页面初始化状态，然后重试连接。';
  }
}).catch(() => {
  actionStatus.textContent = '无法读取客户端信息。';
});

document.getElementById('settings').addEventListener('click', () => {
  void window.opsDesktopSettings.openSettings();
});

document.getElementById('login').addEventListener('click', () => {
  actionStatus.textContent = '正在打开登录页面…';
  void window.opsDesktopSettings.openLoginPage();
});

document.getElementById('retry').addEventListener('click', () => {
  actionStatus.textContent = '正在连接线上服务…';
  void window.opsDesktopSettings.retryBusinessPage();
});
