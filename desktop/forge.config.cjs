const { MakerSquirrel } = require('@electron-forge/maker-squirrel');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'OPS Desktop',
    extraResource: ['renderer'],
    ignore: /^\/(?:out(?:-[^/]+)?|renderer|renderer-src)(?:\/|$)/
  },
  makers: [
    new MakerSquirrel({
      name: 'OPSDesktop',
      noMsi: true
    })
  ]
};
