const { MakerSquirrel } = require('@electron-forge/maker-squirrel');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'OPS Desktop',
    extraResource: ['renderer'],
    // renderer 是 extraResource（desktop/renderer 的构建产物），不打进 asar 本体。
    // 渲染源码已上移到仓库根 renderer/，不在打包根内，无需再排除 renderer-src。
    //
    // DT-06（docs/33 §10.6 / A-06）：打包白名单。修复前 ignore 只排除 out*/renderer，
    // pnpm package 实测（asar list 313 项）把 test/（84 项）、src/（46 项 TS 源码）、
    // chrome-extension/（8 项，W02 技术验证扩展，27 明注"不随产品分发"）、scripts/、
    // .workbuddy-ai/、.playwright-results/ 等全部打进安装包。
    //
    // 运行时必需的白名单（对照 2026-11-11 asar list 核实）：
    // - .build/           主进程编译产物 + worker 资产（含 browser-bridge/diagnostics.html）
    // - node_modules/     运行时依赖（electron-squirrel-startup / pngjs / ws 及其依赖树）
    // - public/           设置窗 HTML/JS 资产（main.ts:736 assetRoot）
    // - chrome-extension/  W02 扩展源码也不进包：native-host 宿主实际在 src/native-host/
    //   （随 src/ 排除），注册脚本 register.cjs 是本机开发用（W02 技术验证，27 明注
    //   "不随产品分发"），安装包无需任何 native messaging 注册文件。
    // - package.json / forge.config.cjs  Electron 打包必需
    // 其余（src 源码、test、脚本、本地工作数据、文档、锁文件）一律排除。
    ignore: [
      /^\/src(\/|$)/,                    // TypeScript 源码（运行时只跑 .build）
      /^\/test(\/|$)/,                   // 单测与 E2E（含 e2e-app 夹具）
      /^\/out(\/|$)/,                    // forge 自身产物
      /^\/renderer(\/|$)/,               // extraResource，不重复进 asar
      /^\/scripts(\/|$)/,                // 开发脚本
      /^\/chrome-extension(\/|$)/,      // W02 技术验证扩展（27 明注不随产品分发）
      /^\/\.workbuddy-ai(\/|$)/,         // 本地工作数据
      /^\/\.playwright-results(\/|$)/,   // 本地测试产物
      /^\/\.tmp(\/|$)/,                  // 本地临时（CfT 等）
      /^\/\.git(dir|ignore|attributes)$/, // 版本控制杂项
      /^\/node_modules\/\.pnpm(\/|$)/,   // pnpm 硬链接目录（依赖已按扁平结构复制）
      /^\/(tsconfig\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/,
      /^\/(README\.md|USER_GUIDE\.md|USER_MANUAL\.md|RELEASE_RUNBOOK\.md)$/,
    ],
  },
  makers: [
    new MakerSquirrel({
      name: 'OPSDesktop',
      noMsi: true
    })
  ]
};
