import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// Service Worker 注册与自动更新
// 策略：检测到新版本时立即 skipWaiting + clients.claim + 刷新页面
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then((registration) => {
      // 立即检查是否有更新
      registration.update().catch(() => {});

      // 监听新的 service worker 安装
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          // 新 worker 安装完成且当前有旧 worker 控制页面时，提示刷新
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('[SW] 新版本可用，正在激活...');
            // 发送 skipWaiting 消息给新 worker，强制接管
            newWorker.postMessage({ type: 'SKIP_WAITING' });
            // 短暂延迟后刷新，确保新 worker 已激活
            setTimeout(() => window.location.reload(), 500);
          }
        });
      });
    })
    .catch(() => {});

  // 兜底：每次页面可见性变化时也检查更新
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      navigator.serviceWorker.ready.then((r) => r.update()).catch(() => {});
    }
  });
}
