import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'OPS_')
  const apiTarget = env.OPS_API_TARGET || 'http://localhost:8080'
  const apiHost = new URL(apiTarget).hostname.toLowerCase()
  const localApi = ['localhost', '127.0.0.1', '[::1]'].includes(apiHost)

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': '/src' } },
    define: {
      __OPS_API_BASE__: JSON.stringify((env.OPS_API_BASE || '').replace(/\/+$/, '')),
    },
    server: {
      port: 5173,
      host: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: !localApi, ws: true } },
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('lucide-react/dist/esm/')) return 'lucide-react'
          },
        },
      },
    },
  }
})
