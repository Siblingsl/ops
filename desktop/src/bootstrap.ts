/**
 * Electron 入口必须先装 broken-pipe 防护，再加载主程序。
 * `require('electron')` 会注册默认 uncaughtException 弹窗；若防护装在其后，
 * EPIPE 仍会先被 Electron 弹出来。
 */
import { installBrokenPipeGuard } from './stdio-guard';

installBrokenPipeGuard();
require('./main');
