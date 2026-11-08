#!/usr/bin/env node
// DEV-AI27-02 W02 技术验证：注册 OPS Native Messaging 宿主。
// 生成/复用扩展固定公钥（manifest "key"，公钥非敏感）、计算固定扩展 ID、
// 写 host manifest 与 run-host.bat、写 HKCU 注册表。不修改 Chrome 安装或 profile。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOST_NAME = 'com.ops.desktop.bridge';
const extDir = path.resolve(__dirname, '..', '..', 'chrome-extension');
const hostDir = __dirname;
const manifestPath = path.join(extDir, 'manifest.json');

function computeExtensionId(spkiDer) {
  const hash = crypto.createHash('sha256').update(spkiDer).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const b = hash[i];
    id += String.fromCharCode(97 + (b >> 4));
    id += String.fromCharCode(97 + (b & 0x0f));
  }
  return id;
}

function ensureManifestKey() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.key && manifest.key.length > 300) {
    // 复用既有公钥：chrome 会用 key 字段校验并派生扩展 ID。
    const spki = Buffer.from(manifest.key, 'base64');
    return { manifest, extensionId: computeExtensionId(spki) };
  }
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  manifest.key = publicKey.toString('base64');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, extensionId: computeExtensionId(publicKey) };
}

function locateNode() {
  const candidate = process.execPath;
  if (path.basename(candidate).toLowerCase().startsWith('node')) return candidate;
  const fromPath = spawnSync('where', ['node'], { encoding: 'utf8' });
  if (fromPath.status === 0) {
    const first = String(fromPath.stdout).split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  throw new Error('未找到 node.exe，无法注册 Native Messaging 宿主');
}

function writeHostFiles(extensionId, nodeExe) {
  const hostManifest = {
    name: HOST_NAME,
    description: 'OPS Desktop Native Messaging Host (W02 verification)',
    path: path.join(hostDir, 'run-host.bat'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestJsonPath = path.join(hostDir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestJsonPath, JSON.stringify(hostManifest, null, 2) + '\n');

  const bat = [
    '@echo off',
    `"${nodeExe}" "${path.join(hostDir, 'host.js')}" %*`,
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(hostDir, 'run-host.bat'), bat, 'utf8');
  return manifestJsonPath;
}

function writeRegistry(manifestJsonPath) {
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  const reg = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestJsonPath, '/f'], { encoding: 'utf8' });
  if (reg.status !== 0) {
    throw new Error(`reg add 失败：${reg.stderr || reg.stdout}`);
  }
  return key;
}

function main() {
  if (process.argv.includes('--unregister')) {
    const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
    const reg = spawnSync('reg', ['delete', key, '/f'], { encoding: 'utf8' });
    console.log(reg.status === 0 ? `已删除注册表 ${key}` : `注册表删除返回 ${reg.status}（可能本就未注册）`);
    return;
  }
  const { extensionId } = ensureManifestKey();
  const nodeExe = locateNode();
  const manifestJsonPath = writeHostFiles(extensionId, nodeExe);
  const registryKey = writeRegistry(manifestJsonPath);
  console.log('OPS Native Messaging 宿主注册完成（W02 验证）：');
  console.log(`  扩展 ID        : ${extensionId}`);
  console.log(`  扩展目录       : ${extDir}`);
  console.log(`  host manifest  : ${manifestJsonPath}`);
  console.log(`  注册表         : ${registryKey}`);
  console.log(`  node           : ${nodeExe}`);
  console.log('后续：Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择上述扩展目录。');
console.log('W12 说明：打包安装后，host manifest 路径应指向安装目录内脚本（--packaged 参数将由安装器传入）；'
  + '当前注册为本机开发路径，卸载用 --unregister。');
}

main();
