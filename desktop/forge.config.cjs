const { MakerSquirrel } = require('@electron-forge/maker-squirrel');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'OPS Desktop',
    extraResource: ['renderer'],
    // renderer 是 extraResource（desktop/renderer 的构建产物），不打进 asar 本体。
    // 渲染源码已上移到仓库根 renderer/，不在打包根内，无需再排除 renderer-src。
    ignore: /^\/(?:out(?:-[^/]+)?|renderer)(?:\/|$)/
  },
  makers: [
    new MakerSquirrel({
      name: 'OPSDesktop',
      noMsi: true
    })
  ]
};
