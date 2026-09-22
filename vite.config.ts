import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Firebase Auth + Firestore with offline persistence is ~600 kB on its own.
  build: { chunkSizeWarningLimit: 700 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Work Hours',
        short_name: 'Hours',
        description: 'Track your work hours and earnings.',
        theme_color: '#0f766e',
        background_color: '#f6f7f9',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The PDF font (~750 KB) is precached so export works offline.
        globPatterns: ['**/*.{js,css,html,png,svg,ttf}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // Firebase Auth's redirect handler lives under /__/ on Firebase Hosting;
        // the service worker must never answer those requests with index.html.
        navigateFallbackDenylist: [/^\/__\//],
      },
    }),
  ],
});
