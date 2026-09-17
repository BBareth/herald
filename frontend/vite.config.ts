import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the backend in production, so dev proxies /api to
// it and the built output lands where the single image expects it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Matches the cache rule the backend applies to /static/.
    assetsDir: 'static',
    sourcemap: false,
  },
});
