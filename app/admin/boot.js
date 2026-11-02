'use strict';

// Initial bootstrap
(async () => {
  if (!await checkAuth()) return;
  const frame = document.getElementById('clusterIframe');
  if (frame?.dataset.adminSrc) {
    frame.src = frame.dataset.adminSrc;
    delete frame.dataset.adminSrc;
  }
  switchTab(getTabFromUrl(), { updateHistory: false });
})().catch(error => {
  console.error('[Admin] 初始化失败:', error);
  showToast('管理后台初始化失败，请刷新页面重试', 'error');
});

