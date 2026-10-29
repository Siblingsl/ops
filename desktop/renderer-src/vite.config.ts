// @ts-ignore Vite loads this config in Node; the browser app intentionally has no Node type dependency.
import { lookup } from 'node:dns/promises'
// @ts-ignore Vite loads this config in Node; the browser app intentionally has no Node type dependency.
import { createRequire } from 'node:module'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, '.', 'OPS_')
  const desktopBuild = mode === 'desktop'
  const apiTarget = env.OPS_API_TARGET || 'http://localhost:8080'
  const target = new URL(apiTarget)
  const apiHost = target.hostname.toLowerCase()
  const localApi = ['localhost', '127.0.0.1', '[::1]'].includes(apiHost)
  let apiAgent

  if (env.OPS_API_PROXY && !localApi) {
    if (target.protocol === 'https:') {
      const targetAddress = (await lookup(apiHost, { all: true, verbatim: true }))[0]
      if (!targetAddress) throw new Error('业务 API 域名解析为空。')
      const { createPinnedHttpsProxyAgent } = require('../.build/proxy.js')
      apiAgent = createPinnedHttpsProxyAgent(
        { url: env.OPS_API_PROXY },
        apiHost,
        Number(target.port || 443),
        targetAddress.address
      )
    } else if (target.protocol === 'http:') {
      const { HttpProxyAgent } = require('http-proxy-agent')
      apiAgent = new HttpProxyAgent(env.OPS_API_PROXY)
    } else {
      throw new Error('远程业务 API 只支持 HTTP 或 HTTPS。')
    }
  }

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': '/src' } },
    // Web 默认使用同源路径；桌面发行包单独构建并直连后端 API。
    define: {
      __OPS_API_BASE__: JSON.stringify((env.OPS_API_BASE || (desktopBuild ? 'https://ops-api.88813888.xyz' : '')).replace(/\/+$/, '')),
    },
    server: {
      port: 5173,
      host: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: !localApi, ws: true, ...(apiAgent ? { agent: apiAgent } : {}) } },
    },
    build: {
      outDir: desktopBuild ? '../renderer' : 'dist',
      emptyOutDir: desktopBuild,
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
