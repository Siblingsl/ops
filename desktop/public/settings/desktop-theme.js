(() => {
  const root = document.documentElement;
  const key = 'ops-desktop-theme';
  const motionKey = 'ops-desktop-motion';
  const sharedTheme = '__OPS_DESKTOP_THEME__';
  const sharedMotion = '__OPS_DESKTOP_REDUCED_MOTION__';
  root.dataset.presentation = 'ops-creative-desktop';
  root.dataset.theme = sharedTheme === 'dark' || sharedTheme === 'light'
    ? sharedTheme
    : localStorage.getItem(key) === 'dark' ? 'dark' : 'light';
  localStorage.setItem(key, root.dataset.theme);
  const systemReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const storedMotion = localStorage.getItem(motionKey) === 'reduce';
  root.dataset.reducedMotion = String(sharedMotion === 'true' || (sharedMotion === 'system' && (storedMotion || systemReduced)));
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    root.dataset.theme = event.matches ? 'dark' : 'light';
    localStorage.setItem(key, root.dataset.theme);
  });
  window.addEventListener('ops:desktop-theme', (event) => {
    root.dataset.theme = event.detail;
    try { localStorage.setItem(key, event.detail); } catch {}
  });

  document.querySelectorAll('[data-desktop-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = theme;
      localStorage.setItem(key, theme);
      window.open(`ops-desktop://ui/theme/${theme}`, '_blank', 'noopener,noreferrer');
    });
  });

  window.open(`ops-desktop://ui/theme/${root.dataset.theme}`, '_blank', 'noopener,noreferrer');

  const syncMotionButtons = () => document.querySelectorAll('[data-desktop-motion-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', root.dataset.reducedMotion);
    button.setAttribute('aria-label', root.dataset.reducedMotion === 'true' ? '关闭手动减少动态效果' : '减少动态效果');
    button.title = root.dataset.reducedMotion === 'true' ? '动态效果已减少' : '轻快动效';
  });
  syncMotionButtons();
  window.addEventListener('ops:desktop-motion', (event) => {
    root.dataset.reducedMotion = String(event.detail);
    try { localStorage.setItem(motionKey, event.detail ? 'reduce' : 'soft'); } catch {}
    syncMotionButtons();
  });

  document.querySelectorAll('[data-desktop-motion-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const reduced = root.dataset.reducedMotion !== 'true';
      root.dataset.reducedMotion = String(reduced);
      localStorage.setItem(motionKey, reduced ? 'reduce' : 'soft');
      syncMotionButtons();
      window.open(`ops-desktop://ui/motion/${reduced ? 'reduce' : 'soft'}`, '_blank', 'noopener,noreferrer');
    });
  });
})();
