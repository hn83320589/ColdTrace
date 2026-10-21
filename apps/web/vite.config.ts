import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.COLDTRACE_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
});
