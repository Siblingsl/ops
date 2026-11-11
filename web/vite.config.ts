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
      // DEV-P11：告警阈值回到可观察水平；大 chunk 靠 manualChunks 拆分而非抬阈值。
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return
            if (id.includes('@tiptap') || id.includes('prosemirror') || id.includes('tiptap-markdown')) return 'vendor-tiptap'
            if (id.includes('@tanstack/react-query')) return 'vendor-query'
            if (id.includes('lucide-react')) return 'lucide-react'
            if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react'
          },
        },
      },
    },
  }
})
