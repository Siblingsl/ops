import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { createPinnedHttpsProxyAgent, normalizeProxyUrl, type ProxyRoute } from './proxy';

const CHUNK_BYTES = 64 * 1024;
const REQUEST_WINDOW = 4 * CHUNK_BYTES;
const RESPONSE_WINDOW = 4 * CHUNK_BYTES;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 18 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 4096;
const DEADLINE_MATCH_TOLERANCE_MS = 2000;
const CONNECT_TIMEOUT_MS = 10_000;

interface WorkerCommand {
  type?: string;
  requestId?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  operation?: 'chat_completions' | 'image_generations' | 'generated_image_fetch';
  bodyLength?: number;
  deadlineMs?: number;
  deadlineAt?: number;
  data?: Uint8Array;
  count?: number;
  providerId?: string;
  configRevision?: number;
  generation?: number;
  purpose?: 'business' | 'self_test';
  parentRequestId?: string;
  allowedImageHosts?: string[];
  targetUrl?: string;
  allowed?: boolean;
  proxy?: ProxyRoute;
}

interface WorkerMessage {
  type: string;
  requestId: string;
  code?: string;
  data?: Uint8Array;
  status?: number;
  contentType?: string;
  retryAfter?: string;
  count?: number;
  targetUrl?: string;
  proxy?: ProxyRoute;
}

interface ActiveRequest {
  id: string;
  baseUrl: string;
  apiKey: string;
  operation: 'chat_completions' | 'image_generations' | 'generated_image_fetch';
  model: string;
  expectedBytes: number;
  deadlineMs: number;
  deadlineAt: number;
  providerId: string;
  configRevision: number;
  generation: number;
  purpose: 'business' | 'self_test';
  parentRequestId?: string;
  allowedImageHosts: string[];
  receivedBytes: number;
  sentRequestBytes: number;
  requestEnded: boolean;
  request?: ClientRequest;
  response?: IncomingMessage;
  inbound: Buffer[];
  inboundBytes: number;
  waitingForDrain: boolean;
  consumedOnDrain: number;
  responseCredits: number;
  responseBuffers: Buffer[];
  responseBufferBytes: number;
  responseEnded: boolean;
  responseHeadersSent: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responseBytes: number;
  responseCapture: Buffer[];
  responseCaptureBytes: number;
  failed: boolean;
  pendingResponseError?: 'credential_echo' | 'upstream_stream_failed';
  scanner: SecretScanner | null;
  timeout: NodeJS.Timeout;
  connectionTimeout?: NodeJS.Timeout;
  proxyCheckResolve?: (result: { allowed: boolean; proxy?: ProxyRoute }) => void;
  proxyAgent?: https.Agent;
}

interface ImageAuthorization {
  url: string;
  providerId: string;
  configRevision: number;
  generation: number;
  purpose: 'business' | 'self_test';
  model: string;
  deadlineAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const active = new Map<string, ActiveRequest>();
const imageAuthorizations = new Map<string, ImageAuthorization>();
const parentPort = process.parentPort;

if (process.env.OPS_DESKTOP_WORKER !== '1') process.exit(1);

parentPort.on('message', (event) => {
  const command = event.data as WorkerCommand;
  if (command.type === 'shutdown') {
    for (const request of active.values()) cancelRequest(request);
    process.exit(0);
    return;
  }
  if (command.type === 'request-open') {
    openRequest(command);
    return;
  }
  if (command.type === 'target-check-result') {
    const waiting = active.get(command.requestId ?? '');
    const proxy = normalizeProxyRoute(command.proxy);
    const allowed = command.allowed === true && (command.proxy === undefined || Boolean(proxy));
    waiting?.proxyCheckResolve?.({ allowed, ...(proxy ? { proxy } : {}) });
    if (waiting) waiting.proxyCheckResolve = undefined;
    return;
  }
  if (command.type === 'clear-authorizations') {
    clearImageAuthorizations();
    return;
  }
  if (command.type === 'clear-parent-authorization') {
    clearImageAuthorization(command.requestId ?? '');
    return;
  }
  const request = active.get(command.requestId ?? '');
  if (!request) return;
  if (command.type === 'request-data') {
    receiveRequestData(request, command.data);
  } else if (command.type === 'request-end') {
    endRequestBody(request);
  } else if (command.type === 'request-cancel') {
    cancelRequest(request);
  } else if (command.type === 'response-credit') {
    addResponseCredit(request, command.count);
  }
});

parentPort.postMessage({ type: 'worker-ready' });

function openRequest(command: WorkerCommand): void {
  const id = command.requestId ?? '';
  const baseUrl = command.baseUrl ?? '';
  const operation = command.operation;
  const apiKey = command.apiKey ?? '';
  const expectedBytes = command.bodyLength ?? 0;
  const deadlineMs = command.deadlineMs ?? 0;
  if (!/^[0-9a-f-]{36}$/i.test(id) || active.has(id) || !operation
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_REQUEST_BYTES
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10 * 60 * 1000
    || !Number.isSafeInteger(command.deadlineAt) || (command.deadlineAt ?? 0) <= Date.now()
    || !['chat_completions', 'image_generations', 'generated_image_fetch'].includes(operation)
    || !command.providerId || !command.model || !Number.isSafeInteger(command.configRevision) || (command.configRevision ?? 0) < 1
    || !Number.isSafeInteger(command.generation) || (command.generation ?? 0) < 1
    || (command.purpose !== 'business' && command.purpose !== 'self_test')
    || operation === 'generated_image_fetch' && (!command.parentRequestId || apiKey !== '')
    || apiKey.length > MAX_CREDENTIAL_BYTES) {
    post({ type: 'request-error', requestId: id, code: 'protocol' });
    return;
  }

  const request: ActiveRequest = {
    id,
    baseUrl,
    apiKey,
    operation,
    model: command.model!,
    expectedBytes,
    deadlineMs,
    deadlineAt: command.deadlineAt!,
    providerId: command.providerId!,
    configRevision: command.configRevision!,
    generation: command.generation!,
    purpose: command.purpose!,
    parentRequestId: command.parentRequestId,
    allowedImageHosts: normalizeAllowedHosts(command.allowedImageHosts ?? []),
    receivedBytes: 0,
    sentRequestBytes: 0,
    requestEnded: false,
    inbound: [],
    inboundBytes: 0,
    waitingForDrain: false,
    consumedOnDrain: 0,
    responseCredits: 0,
    responseBuffers: [],
    responseBufferBytes: 0,
    responseEnded: false,
    responseHeadersSent: false,
    responseBytes: 0,
    responseCapture: [],
    responseCaptureBytes: 0,
    failed: false,
    scanner: apiKey ? new SecretScanner(apiKey) : null,
    timeout: setTimeout(() => fail(request, 'timeout'), Math.max(0, command.deadlineAt! - Date.now()))
  };
  request.timeout.unref();
  active.set(id, request);
  if (request.operation !== 'generated_image_fetch') void startUpstream(request);
}

async function startUpstream(state: ActiveRequest): Promise<void> {
  try {
    if (state.operation === 'generated_image_fetch') return;
    const { url, addresses } = await resolvePinnedTarget(state.baseUrl, state.operation);
    if (state.failed || !active.has(state.id)) return;
    const proxyCheck = await askMainProxyCheck(state, url.toString());
    if (!proxyCheck.allowed) {
      fail(state, 'offline');
      return;
    }
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream, application/octet-stream, image/*',
      'Content-Type': 'application/json',
      'Content-Length': String(state.expectedBytes)
    };
    if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
    startPinnedRequest(state, url, addresses, 'POST', headers, proxyCheck.proxy);
  } catch {
    fail(state, 'offline');
  }
}

function startPinnedRequest(
  state: ActiveRequest,
  url: URL,
  addresses: Array<{ address: string; family: number }>,
  method: 'POST' | 'GET',
  headers: Record<string, string>,
  proxy?: ProxyRoute
): void {
  const first = addresses[0];
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  };
  if (proxy && url.protocol !== 'https:') {
    fail(state, 'protocol');
    return;
  }
  const proxyAgent = proxy
    ? createPinnedHttpsProxyAgent(proxy, url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 443), first.address)
    : undefined;
  state.proxyAgent = proxyAgent;
  const client = url.protocol === 'https:' ? https : http;
  const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      agent: proxyAgent ?? false,
      lookup,
      ...(url.protocol === 'https:' && isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0
        ? { servername: url.hostname } : {})
    });
  state.request = request;
  state.connectionTimeout = setTimeout(() => fail(state, 'timeout'), CONNECT_TIMEOUT_MS);
  state.connectionTimeout.unref();
  request.once('socket', (socket) => {
    const connected = () => {
      clearTimeout(state.connectionTimeout);
      state.connectionTimeout = undefined;
    };
    if (url.protocol === 'https:') {
      const tlsSocket = socket as TLSSocket & { secureConnecting?: boolean };
      if (tlsSocket.secureConnecting !== false) tlsSocket.once('secureConnect', connected);
      else connected();
    } else if (socket.connecting) socket.once('connect', connected);
    else connected();
  });
  request.on('response', (response) => {
    clearTimeout(state.connectionTimeout);
    state.connectionTimeout = undefined;
    onUpstreamResponse(state, response);
  });
  request.on('error', () => {
    if (!state.failed) fail(state, 'offline');
  });
  request.on('drain', () => {
    state.waitingForDrain = false;
    const consumed = state.consumedOnDrain;
    state.consumedOnDrain = 0;
    for (let index = 0; index < consumed; index++) {
      post({ type: 'request-consumed', requestId: state.id });
    }
    flushRequestBody(state);
  });
  flushRequestBody(state);
}

function askMainProxyCheck(state: ActiveRequest, targetUrl: string): Promise<{ allowed: boolean; proxy?: ProxyRoute }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ allowed: false }), 5000);
    const finish = (result: { allowed: boolean; proxy?: ProxyRoute }) => {
      clearTimeout(timer);
      state.proxyCheckResolve = undefined;
      resolve(result);
    };
    state.proxyCheckResolve = finish;
    post({ type: 'target-check', requestId: state.id, targetUrl });
  });
}

async function resolvePinnedTarget(
  baseUrl: string,
  operation: 'chat_completions' | 'image_generations'
): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.search || base.hash) throw new Error('invalid endpoint');
  const hostname = base.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = isLoopbackName(hostname);
  if (base.protocol === 'http:' && !loopback) throw new Error('insecure endpoint');

  const suffix = operation === 'chat_completions' ? 'chat/completions' : 'images/generations';
  const url = new URL(suffix, ensureTrailingSlash(base));
  if (url.origin !== base.origin) throw new Error('endpoint escaped base URL');
  return { url, addresses: await resolveAddresses(hostname, loopback) };
}

async function resolveAddresses(
  hostname: string,
  allowLoopback: boolean
): Promise<Array<{ address: string; family: number }>> {
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : (await dnsLookup(hostname, { all: true, verbatim: true }))
      .map((entry) => ({ address: entry.address, family: entry.family }));
  if (addresses.length === 0 || addresses.length > 32
    || addresses.some((entry) => !isAllowedAddress(entry.address, allowLoopback))) {
    throw new Error('endpoint resolved to a blocked address');
  }
  return addresses;
}

function ensureTrailingSlash(url: URL): string {
  const copy = new URL(url);
  if (!copy.pathname.endsWith('/')) copy.pathname += '/';
  return copy.toString();
}

function isAllowedAddress(address: string, allowLoopback: boolean): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    const loopback = a === 127;
    if (loopback) return allowLoopback;
    if (a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 0 && (c === 0 || c === 2) || b === 168 || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113 || a >= 224) return false;
    return true;
  }
  if (family !== 6) return false;
  const bytes = parseIpv6(address);
  if (!bytes) return false;
  const loopback = bytes.slice(0, 15).every((part) => part === 0) && bytes[15] === 1;
  if (loopback) return allowLoopback;
  const globallyRoutable = (bytes[0] & 0xe0) === 0x20;
  if (!globallyRoutable) return false;
  const first16 = (bytes[0] << 8) | bytes[1];
  const first32 = first16 * 0x10000 + (bytes[2] << 8) + bytes[3];
  if ((first16 >= 0x2001 && first16 <= 0x2001 && bytes[2] <= 1)
    || first32 === 0x20010db8 || first16 === 0x2002
    || (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0)) {
    return false;
  }
  return true;
}

function parseIpv6(value: string): number[] | null {
  const normalized = value.toLowerCase();
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (part: string): number[] | null => {
    if (!part) return [];
    const words: number[] = [];
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        const family = isIP(piece);
        if (family !== 4) return null;
        const octets = piece.split('.').map(Number);
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        words.push(Number.parseInt(piece, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right || (halves.length === 1 && left.length !== 8)) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || halves.length === 2 && missing < 1) return null;
  const words = [...left, ...Array<number>(missing).fill(0), ...right];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function receiveRequestData(state: ActiveRequest, data?: Uint8Array): void {
  if (state.failed || !data) return;
  const chunk = Buffer.from(data);
  if (chunk.length === 0 || chunk.length > CHUNK_BYTES
    || state.receivedBytes + chunk.length > state.expectedBytes
    || state.inboundBytes + chunk.length > REQUEST_WINDOW) {
    fail(state, 'protocol');
    return;
  }
  state.receivedBytes += chunk.length;
  state.inboundBytes += chunk.length;
  state.inbound.push(chunk);
  flushRequestBody(state);
}

function flushRequestBody(state: ActiveRequest): void {
  if (state.failed || !state.request || state.waitingForDrain) return;
  while (state.inbound.length > 0) {
    const chunk = state.inbound.shift()!;
    state.inboundBytes -= chunk.length;
    state.sentRequestBytes += chunk.length;
    if (state.sentRequestBytes > state.expectedBytes) {
      fail(state, 'protocol');
      return;
    }
    const accepted = state.request.write(chunk);
    if (!accepted) {
      state.waitingForDrain = true;
      state.consumedOnDrain++;
      return;
    }
    post({ type: 'request-consumed', requestId: state.id });
  }
  if (state.requestEnded) {
    if (state.sentRequestBytes !== state.expectedBytes) {
      fail(state, 'protocol');
      return;
    }
    state.request.end();
  }
}

function endRequestBody(state: ActiveRequest): void {
  if (state.failed || state.requestEnded || state.receivedBytes !== state.expectedBytes) {
    fail(state, 'protocol');
    return;
  }
  state.requestEnded = true;
  if (state.operation === 'generated_image_fetch') {
    void startGeneratedImageFetch(state);
    return;
  }
  flushRequestBody(state);
  flushResponse(state);
}

async function startGeneratedImageFetch(state: ActiveRequest): Promise<void> {
  try {
    const rawBody = Buffer.concat(state.inbound, state.inboundBytes).toString('utf8');
    state.inbound = [];
    state.inboundBytes = 0;
    if (Buffer.byteLength(rawBody, 'utf8') > 8192) throw new Error('oversized image fetch body');
    const body = JSON.parse(rawBody) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || typeof (body as { url?: unknown }).url !== 'string') {
      throw new Error('invalid image fetch body');
    }
    const requestedUrl = (body as { url: string }).url;
    const parentId = state.parentRequestId ?? '';
    const authorization = imageAuthorizations.get(parentId);
    clearImageAuthorization(parentId);
    purgeImageAuthorizations();
    if (!authorization || authorization.expiresAt <= Date.now()
      || requestedUrl !== authorization.url
      || state.providerId !== authorization.providerId
      || state.model !== authorization.model
      || state.configRevision !== authorization.configRevision
      || state.generation !== authorization.generation
      || state.purpose !== authorization.purpose
      || Math.abs(state.deadlineAt - authorization.deadlineAt) > DEADLINE_MATCH_TOLERANCE_MS) {
      throw new Error('image URL is not authorized');
    }

    const target = new URL(requestedUrl);
    const base = new URL(state.baseUrl);
    if (target.username || target.password || target.hash) throw new Error('invalid image URL');
    const sameOrigin = target.origin === base.origin;
    const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (sameOrigin) {
      if (target.protocol !== base.protocol) throw new Error('image scheme mismatch');
    } else if (target.protocol !== 'https:' || !state.allowedImageHosts.includes(hostname)) {
      throw new Error('image host is not allowed');
    }
    const addresses = await resolveAddresses(hostname, sameOrigin && isLoopbackName(hostname));
    if (state.failed || !active.has(state.id)) return;
    const proxyCheck = await askMainProxyCheck(state, target.toString());
    if (!proxyCheck.allowed) {
      fail(state, 'offline');
      return;
    }
    state.sentRequestBytes = state.expectedBytes;
    startPinnedRequest(state, target, addresses, 'GET', { Accept: 'image/*' }, proxyCheck.proxy);
  } catch {
    fail(state, 'protocol');
  }
}

function purgeImageAuthorizations(): void {
  const now = Date.now();
  for (const [requestId, authorization] of imageAuthorizations) {
    if (authorization.expiresAt <= now) clearImageAuthorization(requestId);
  }
  while (imageAuthorizations.size > 16) {
    const oldest = imageAuthorizations.keys().next().value as string | undefined;
    if (!oldest) break;
    clearImageAuthorization(oldest);
  }
}

function clearImageAuthorization(requestId: string): void {
  const authorization = imageAuthorizations.get(requestId);
  if (authorization) clearTimeout(authorization.timer);
  imageAuthorizations.delete(requestId);
}

function clearImageAuthorizations(): void {
  for (const authorization of imageAuthorizations.values()) clearTimeout(authorization.timer);
  imageAuthorizations.clear();
}

function onUpstreamResponse(state: ActiveRequest, response: IncomingMessage): void {
  if (state.failed) {
    response.destroy();
    return;
  }
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    response.destroy();
    fail(state, 'redirect');
    return;
  }
  const contentType = firstHeader(response.headers['content-type']);
  if (!allowedContentType(contentType)) {
    response.destroy();
    fail(state, 'protocol');
    return;
  }
  if (state.operation === 'generated_image_fetch'
    && (status !== 200 || !contentType.split(';', 1)[0].trim().toLowerCase().startsWith('image/'))) {
    response.destroy();
    fail(state, 'protocol');
    return;
  }
  const maxBytes = state.operation === 'image_generations' ? MAX_IMAGE_RESPONSE_BYTES
    : state.operation === 'generated_image_fetch' ? 12 * 1024 * 1024 : MAX_RESPONSE_BYTES;
  state.response = response;
  state.responseStatus = status;
  state.responseContentType = contentType;
  state.responseHeadersSent = true;
  post({
    type: 'response-headers', requestId: state.id, status, contentType,
    retryAfter: validRetryAfter(firstHeader(response.headers['retry-after']))
      ? firstHeader(response.headers['retry-after']) : undefined
  });
  response.on('data', (raw: Buffer | string) => {
    if (state.failed) return;
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    state.responseBytes += data.length;
    if (state.responseBytes > maxBytes) {
      fail(state, 'protocol');
      return;
    }
    if (state.operation === 'image_generations') {
      state.responseCapture.push(Buffer.from(data));
      state.responseCaptureBytes += data.length;
    }
    const safe = state.scanner?.push(data) ?? { data, credentialEcho: false };
    if (safe.data.length > 0) enqueueResponse(state, safe.data);
    if (safe.credentialEcho) {
      fail(state, 'credential_echo');
      return;
    }
    if (state.responseBufferBytes >= RESPONSE_WINDOW) response.pause();
  });
  response.on('end', () => {
    if (state.failed) return;
    const tail = state.scanner?.finish() ?? Buffer.alloc(0);
    if (tail.length > 0) enqueueResponse(state, tail);
    if (state.operation === 'image_generations') rememberImageUrl(state);
    state.responseEnded = true;
    flushResponse(state);
  });
  response.on('error', () => {
    if (!state.failed) fail(state, 'upstream_stream_failed');
  });
  response.on('aborted', () => {
    if (!state.failed) fail(state, 'upstream_stream_failed');
  });
}

function rememberImageUrl(state: ActiveRequest): void {
  if (state.responseStatus !== 200
    || state.responseContentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return;
  const parentId = state.id;
  try {
    const payload = JSON.parse(Buffer.concat(state.responseCapture, state.responseCaptureBytes).toString('utf8')) as {
      data?: Array<{ url?: unknown }>;
    };
    if (!Array.isArray(payload.data) || payload.data.length !== 1) return;
    const url = payload.data[0]?.url;
    if (typeof url !== 'string' || url.length === 0 || url.length > 8192) return;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return;
    purgeImageAuthorizations();
    const expiresAt = state.deadlineAt;
    const timer = setTimeout(() => clearImageAuthorization(parentId), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    imageAuthorizations.set(parentId, {
      url,
      providerId: state.providerId,
      model: state.model,
      configRevision: state.configRevision,
      generation: state.generation,
      purpose: state.purpose,
      deadlineAt: state.deadlineAt,
      expiresAt,
      timer
    });
    purgeImageAuthorizations();
    post({ type: 'image-url-ready', requestId: parentId });
  } catch {
    // Responses without a first URL cannot authorize a later image fetch.
  } finally {
    for (const chunk of state.responseCapture) chunk.fill(0);
    state.responseCapture = [];
    state.responseCaptureBytes = 0;
  }
}

function enqueueResponse(state: ActiveRequest, data: Buffer): void {
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.length));
    state.responseBuffers.push(chunk);
    state.responseBufferBytes += chunk.length;
  }
  if (state.responseBufferBytes > RESPONSE_WINDOW + CHUNK_BYTES) {
    fail(state, 'protocol');
    return;
  }
  flushResponse(state);
}

function addResponseCredit(state: ActiveRequest, count?: number): void {
  if (!Number.isSafeInteger(count) || !count || count < 1 || count > RESPONSE_WINDOW
    || state.responseCredits + count > RESPONSE_WINDOW) {
    fail(state, 'protocol');
    return;
  }
  state.responseCredits += count;
  flushResponse(state);
}

function flushResponse(state: ActiveRequest): void {
  while ((!state.failed || state.pendingResponseError) && state.responseBuffers.length > 0 && state.responseCredits > 0) {
    const head = state.responseBuffers[0];
    const length = Math.min(head.length, state.responseCredits, CHUNK_BYTES);
    const part = head.subarray(0, length);
    if (length === head.length) state.responseBuffers.shift();
    else state.responseBuffers[0] = head.subarray(length);
    state.responseBufferBytes -= length;
    state.responseCredits -= length;
    post({ type: 'response-data', requestId: state.id, data: Uint8Array.from(part) });
  }
  if (!state.failed && state.response && state.responseBufferBytes < RESPONSE_WINDOW) state.response.resume();
  if (state.pendingResponseError && state.responseBuffers.length === 0) {
    finishResponseError(state);
    return;
  }
  if (state.responseEnded && state.requestEnded && state.responseBuffers.length === 0 && !state.failed) {
    post({ type: 'response-end', requestId: state.id });
    disposeRequest(state);
  }
}

function fail(state: ActiveRequest, code: string): void {
  if (state.failed) {
    if (state.pendingResponseError && code === 'timeout') finishResponseError(state);
    return;
  }
  state.failed = true;
  state.scanner?.clear();
  state.response?.destroy();
  state.request?.destroy();
  const afterHeaders = state.responseHeadersSent;
  if (afterHeaders) {
    state.pendingResponseError = code === 'credential_echo' ? 'credential_echo' : 'upstream_stream_failed';
    flushResponse(state);
    return;
  }
  post({
    type: 'request-error',
    requestId: state.id,
    code: allowedRequestError(code)
  });
  disposeRequest(state);
}

function finishResponseError(state: ActiveRequest): void {
  const code = state.pendingResponseError;
  if (!code) return;
  state.pendingResponseError = undefined;
  post({ type: 'response-error', requestId: state.id, code });
  disposeRequest(state);
}

function allowedRequestError(code: string): string {
  return ['offline', 'timeout', 'redirect', 'protocol', 'unauthorized'].includes(code)
    ? code : 'offline';
}

function cancelRequest(state: ActiveRequest): void {
  state.failed = true;
  state.scanner?.clear();
  state.response?.destroy();
  state.request?.destroy();
  disposeRequest(state);
}

function disposeRequest(state: ActiveRequest): void {
  clearTimeout(state.timeout);
  clearTimeout(state.connectionTimeout);
  state.connectionTimeout = undefined;
  state.proxyCheckResolve?.({ allowed: false });
  state.proxyCheckResolve = undefined;
  state.proxyAgent?.destroy();
  state.proxyAgent = undefined;
  for (const chunk of state.inbound) chunk.fill(0);
  for (const chunk of state.responseBuffers) chunk.fill(0);
  try {
    state.request?.removeHeader('authorization');
  } catch {
    // Node may already have finalized headers; destroying the request releases its reference.
  }
  state.apiKey = '';
  state.inbound = [];
  state.inboundBytes = 0;
  state.responseBuffers = [];
  state.responseBufferBytes = 0;
  for (const chunk of state.responseCapture) chunk.fill(0);
  state.responseCapture = [];
  state.responseCaptureBytes = 0;
  state.scanner?.clear();
  active.delete(state.id);
}

function post(message: WorkerMessage | { type: 'worker-ready' }): void {
  parentPort.postMessage(message);
}

function normalizeProxyRoute(value: ProxyRoute | undefined): ProxyRoute | undefined {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return undefined;
  try {
    const url = normalizeProxyUrl(value.url);
    const username = value.username ?? '';
    const password = value.password ?? '';
    if (typeof username !== 'string' || typeof password !== 'string'
      || username.length > MAX_CREDENTIAL_BYTES || password.length > MAX_CREDENTIAL_BYTES
      || /[\r\n]/.test(username) || /[\r\n]/.test(password)
      || Boolean(username) !== Boolean(password)) return undefined;
    return { url, ...(username ? { username, password } : {}) };
  } catch {
    return undefined;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeAllowedHosts(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 50) return [];
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const host = value.toLowerCase();
    if (host.length > 253 || isIP(host) !== 0 || !host.includes('.')
      || !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) continue;
    result.add(host);
  }
  return [...result];
}

function validRetryAfter(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{1,5}$/.test(value);
}

function allowedContentType(value: string | undefined): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType === 'text/event-stream'
    || mediaType === 'application/octet-stream' || mediaType.startsWith('image/');
}

class SecretScanner {
  private tail = Buffer.alloc(0);
  private readonly patterns: Buffer[];
  private readonly maxPatternLength: number;

  constructor(secret: string) {
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    const unicodeEscaped = Array.from(secret).flatMap((character) => {
      const codePoint = character.codePointAt(0)!;
      const units = codePoint <= 0xffff
        ? [codePoint]
        : [0xd800 + ((codePoint - 0x10000) >> 10), 0xdc00 + ((codePoint - 0x10000) & 0x3ff)];
      return units.map((unit) => `\\u${unit.toString(16).padStart(4, '0')}`);
    }).join('');
    const upperHexEscaped = unicodeEscaped.replace(/\\u[0-9a-f]{4}/g, (token) => token.slice(0, 2) + token.slice(2).toUpperCase());
    this.patterns = [...new Set([secret, jsonEscaped, unicodeEscaped, upperHexEscaped])]
      .map((value) => Buffer.from(value, 'utf8'));
    this.maxPatternLength = Math.max(...this.patterns.map((pattern) => pattern.length));
  }

  push(chunk: Buffer): { data: Buffer; credentialEcho: boolean } {
    const combined = Buffer.concat([this.tail, chunk]);
    let firstMatch = -1;
    for (const pattern of this.patterns) {
      const offset = combined.indexOf(pattern);
      if (offset >= 0 && (firstMatch < 0 || offset < firstMatch)) firstMatch = offset;
    }
    if (firstMatch >= 0) {
      this.tail = Buffer.alloc(0);
      return { data: combined.subarray(0, firstMatch), credentialEcho: true };
    }
    const safeLength = Math.max(0, combined.length - this.maxPatternLength + 1);
    this.tail = Buffer.from(combined.subarray(safeLength));
    return { data: combined.subarray(0, safeLength), credentialEcho: false };
  }

  finish(): Buffer {
    const tail = this.tail;
    this.tail = Buffer.alloc(0);
    return tail;
  }

  clear(): void {
    this.tail.fill(0);
    this.tail = Buffer.alloc(0);
    for (const pattern of this.patterns) pattern.fill(0);
  }
}
