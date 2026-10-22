import http from 'node:http';
import https from 'node:https';
import tls, { type TLSSocket } from 'node:tls';
import { isIP, type LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';

export interface ProxyRoute {
  url: string;
  username?: string;
  password?: string;
}

export function parseSystemProxyResolution(value: string): ProxyRoute | null {
  const first = value.split(';', 1)[0]?.trim();
  if (!first) throw new Error('系统代理配置不可用。');
  if (first.toUpperCase() === 'DIRECT') return null;
  const match = /^(PROXY|HTTP|HTTPS)\s+(.+)$/i.exec(first);
  if (!match) throw new Error('系统代理类型不受支持；请改用 HTTPS 代理或直连。');
  const protocol = match[1].toUpperCase() === 'HTTPS' ? 'https:' : 'http:';
  const authority = match[2].trim();
  if (!(/\]:\d+$/.test(authority) || /^[^:]+:\d+$/.test(authority))) {
    throw new Error('系统代理地址必须包含端口。');
  }
  const url = new URL(`${protocol}//${authority}`);
  return { url: normalizeProxyUrl(url.toString()) };
}

export function normalizeProxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('代理地址不是有效 URL。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('代理地址只允许不含凭证、路径和查询参数的 HTTP(S) 主机地址。');
  }
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new Error('代理端口无效。');
  }
  return `${url.protocol}//${url.host}`;
}

export function createPinnedDirectHttpsAgent(addresses: Array<{ address: string; family: number }>): https.Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else {
      const first = addresses[0];
      if (!first) callback(new Error('目标地址解析为空。'), '', 0);
      else callback(null, first.address, first.family);
    }
  };
  return new https.Agent({ lookup, keepAlive: false, maxSockets: 1 });
}

export function createPinnedHttpsProxyAgent(
  proxy: ProxyRoute,
  targetHost: string,
  targetPort: number,
  targetAddress: string
): https.Agent {
  const proxyURL = new URL(normalizeProxyUrl(proxy.url));
  const proxyPort = Number(proxyURL.port || (proxyURL.protocol === 'https:' ? 443 : 80));
  const authorityHost = isIP(targetAddress) === 6 ? `[${targetAddress}]` : targetAddress;
  const authority = `${authorityHost}:${targetPort}`;
  const proxyAuthorization = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`).toString('base64')}`
    : undefined;
  if (proxyAuthorization && proxyURL.protocol !== 'https:' && !isLoopbackHost(proxyURL.hostname)) {
    throw new Error('远程 HTTP 代理不能安全传输代理凭证；请使用 HTTPS 代理或不带认证的代理。');
  }

  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (_options, callback) => {
    let finished = false;
    const finish = (error: Error | null, socket?: TLSSocket) => {
      if (finished) {
        socket?.destroy();
        return;
      }
      finished = true;
      callback?.(error, socket as Duplex);
    };
    const connectHeaders: Record<string, string> = { Host: authority };
    if (proxyAuthorization) connectHeaders['Proxy-Authorization'] = proxyAuthorization;
    const proxyRequest = (proxyURL.protocol === 'https:' ? https : http).request({
      protocol: proxyURL.protocol,
      hostname: proxyURL.hostname.replace(/^\[|\]$/g, ''),
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: connectHeaders,
      ...(proxyURL.protocol === 'https:' && isIP(proxyURL.hostname.replace(/^\[|\]$/g, '')) === 0
        ? { servername: proxyURL.hostname } : {})
    });
    proxyRequest.setTimeout(10_000, () => proxyRequest.destroy(new Error('代理 CONNECT 超时。')));
    proxyRequest.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length > 0) {
        socket.destroy();
        finish(new Error('代理拒绝了安全隧道连接。'));
        return;
      }
      const secureSocket = tls.connect({
        socket,
        host: targetHost,
        port: targetPort,
        rejectUnauthorized: true,
        ...(isIP(targetHost) === 0 ? { servername: targetHost } : {})
      });
      secureSocket.once('secureConnect', () => finish(null, secureSocket));
      secureSocket.once('error', (error) => finish(error));
    });
    proxyRequest.once('response', (response) => {
      response.resume();
      finish(new Error('代理拒绝了安全隧道连接。'));
    });
    proxyRequest.once('error', (error) => finish(error));
    proxyRequest.end();
    return null;
  };
  return agent;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
