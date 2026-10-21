import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.COLDTRACE_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  // ECharts（按需引入後仍約 560 kB）已拆成獨立 chunk、點開圖表前於背景預載，首屏不受影響
  build: { chunkSizeWarningLimit: 600 },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
});
