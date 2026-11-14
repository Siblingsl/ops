import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config'

// CF-P2-DOC-DRV-01：重建 `desktop/renderer-src/qa26-reuse.playwright.config.ts` 的等价配置
//（原文件随 390312cc 渲染包上移删除，等价副本存于 .trash-20261109/desktop/renderer-src/）。
// 与原配置一致：仅把 webServer.reuseExistingServer 打开，其余继承 baseConfig——
// 供历史批次绿跑命令（`-c qa26-reuse.playwright.config.ts`）在当前渲染包位置复跑；
// 真实 Electron 用例的 filechooser 驱动与该开关无关，本配置只恢复命令入口。
export default defineConfig({
  ...baseConfig,
  webServer: Array.isArray(baseConfig.webServer)
    ? baseConfig.webServer.map((server) => ({ ...server, reuseExistingServer: true }))
    : baseConfig.webServer
      ? { ...baseConfig.webServer, reuseExistingServer: true }
      : undefined,
})
