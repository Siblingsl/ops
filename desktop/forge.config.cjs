const { MakerSquirrel } = require('@electron-forge/maker-squirrel');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'OPS Desktop',
    ignore: /^\/out(?:-[^/]+)?(?:\/|$)/
  },
  makers: [
    new MakerSquirrel({
      name: 'OPSDesktop',
      noMsi: true
    })
  ]
};
