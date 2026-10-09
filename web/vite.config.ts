import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': '/src' } },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: false } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
})
