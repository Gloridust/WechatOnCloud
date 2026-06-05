import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const BACKEND = process.env.BACKEND || 'http://localhost:8080';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,  // 手动注册，完全可控
      includeAssets: ['favicon.svg', 'icon-180.png'],
      manifest: {
        name: '云微',
        short_name: '云微',
        description: '在浏览器访问 NAS 上的微信',
        lang: 'zh-CN',
        theme_color: '#07C160',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/desktop/, /^\/api/],
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
