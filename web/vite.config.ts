import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': '/src' } },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: loadEnv(mode, '.', 'OPS_').OPS_API_TARGET || 'http://localhost:8080', changeOrigin: false } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
}))
