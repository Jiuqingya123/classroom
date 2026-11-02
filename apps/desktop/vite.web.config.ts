import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** 浏览器 / Android 共用的纯 Web 构建；产物直接作为 Capacitor 的 webDir */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer') },
  },
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../mobile/www'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
