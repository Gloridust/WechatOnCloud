import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 开发时把 /api 与 /desktop 代理到本地后端（npm run dev 时用）
const BACKEND = process.env.BACKEND || 'http://localhost:8080';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-180.png'],
      manifest: {
        name: '云微',
        short_name: '云微',
        description: '在浏览器访问 NAS 上的微信',
        lang: 'zh-CN',
        theme_color: '#07C160',
        background_color: '#edeff3',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 桌面反代与 API 不能被 SW 拦截
        navigateFallbackDenylist: [/^\/desktop/, /^\/api/],
        // 新版本立即接管 + 清理旧缓存，避免更新后仍跑旧代码（硬刷新绕不过 SW）
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    proxy: {
      '/api': BACKEND,
      '/desktop': { target: BACKEND, ws: true },
    },
  },
  build: { outDir: 'dist' },
});
