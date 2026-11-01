import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

// PWA 更新即时生效：vite-plugin-pwa 用 autoUpdate + skipWaiting + clientsClaim，新版本会立即接管，
// 但当前页仍显示已加载的旧资源，需再刷一次才生效——这正是"改了却还看旧界面"的根源。这里监听 SW 接管，
// 在"本来已有 SW 在控制"（即一次更新，而非首次安装）时自动重载一次，让更新一刷即生效。
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
