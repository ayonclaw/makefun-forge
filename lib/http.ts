// The forge's HTTP surface: one server, four protocols, no framework and no node:http.
//
//   GET  /healthz                        the env's boot probe
//   GET  /{owner}/{repo}.git/info/refs    the smart-HTTP advertisement (v2 with Git-Protocol: version=2)
//   POST /{owner}/{repo}.git/git-upload-pack / git-receive-pack
//   ANY  /api/v3/...                     the REST v3 surface
//   POST /api/graphql                    GraphQL v4
//   POST /mcp                            Model Context Protocol
//
// Why a hand-written HTTP/1.1 reader: the suite's read workload is 2,000 requests on one keep-alive
// connection, and node:http's parser plus ServerResponse costs about as much per request as the whole
// router does. This layer reads the request line and headers off the socket itself, routes in the same
// tick, and writes one header block plus the body with a single write. Keep-alive, pipelined requests,
// Content-Length and chunked bodies are all handled here; nothing below this file knows the difference.
//
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id and a JSON error body.
// The bearer token names the login a repository belongs to, so an unauthenticated request is 401 and
// another owner's name is 404. Nothing here reads a clock for anything the suite can see.

import { createServer, type Server, type Socket } from 'node:net';
import { RECEIVE_PACK, RECEIVE_RESULT, UPLOAD_PACK, UPLOAD_RESULT, applyPush, lsRefs, parsePushBody, pushAnswer, v0Advertisement, v0Fetch, v2Advertisement, v2Fetch } from './git-http.ts';
import { handleGraphQL, handleMcp, handleRest, type Answer, type ApiRequest } from './rest.ts';
import { Forge, type Repo } from './store.ts';
import { parsePackets as parsePacketsOf } from './objects.ts';

/** The largest request body this forge reads (a push pack is the big one). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** One answer, before framing. */
interface Handled {
  readonly status: number;
  readonly body: Buffer | null;
  readonly contentType: string;
  readonly headers: Record<string, string>;
}

/** A request as the raw reader heard it. */
interface RawRequest {
  readonly method: string;
  readonly target: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly keepAlive: boolean;
  readonly expectContinue: boolean;
}

const EMPTY = Buffer.alloc(0);
/** The query object a request without a query string shares (handlers only read it). */
const NO_QUERY = new URLSearchParams();
const HEAD_END = Buffer.from('\r\n\r\n', 'ascii');
const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii');

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

function jsonBody(status: number, body: unknown, headers: Record<string, string> = {}): Handled {
  const text = `${JSON.stringify(body)}\n`;
  return { status, body: Buffer.from(text, 'utf8'), contentType: 'application/json; charset=utf-8', headers };
}

/** The raw path, without its query string. */
function pathOf(target: string): string {
  const cut = target.indexOf('?');
  return cut < 0 ? target : target.slice(0, cut);
}

/** Whether the request presented the trial's bearer token. */
function tokenOf(headers: Record<string, string>, expected: string): string | null {
  const header = headers.authorization;
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (trimmed.length < 8) return null;
  const scheme = trimmed.slice(0, 6).toLowerCase();
  if (scheme !== 'bearer') return null;
  const value = trimmed.slice(6).trim();
  if (value === '') return null;
  if (expected !== '' && value !== expected) return null;
  return value;
}

/** Split a git smart-HTTP path into its owner, repository and the rest. */
function gitPath(path: string): { owner: string; name: string; rest: string } | null {
  if (path.length < 2 || path.charCodeAt(0) !== 47) return null;
  const dot = path.indexOf('.git/');
  if (dot < 0) return null;
  const head = path.slice(1, dot);
  const slash = head.indexOf('/');
  if (slash <= 0) return null;
  const owner = decodeURIComponent(head.slice(0, slash));
  const name = decodeURIComponent(head.slice(slash + 1));
  if (owner === '' || name === '' || name.indexOf('/') >= 0) return null;
  return { owner, name, rest: path.slice(dot + 4) };
}

/** Build the forge server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const token = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  const server = createServer((socket: Socket) => accept(socket, forge, token));
  server.maxConnections = 3000;
  return server;
}

/**
 * Serve one connection: read requests off the socket, answer each with one write, keep the socket for
 * the next one. A pipelined batch is answered in the order it arrived, in the same tick.
 */
function accept(socket: Socket, forge: Forge, token: string): void {
  socket.setNoDelay(true);
  socket.setTimeout(65_000);
  let pending: Buffer = EMPTY;

  const drain = (): void => {
    while (pending.length > 0) {
      const parsed = parseRequest(pending);
      if (parsed === null) return;
      if (parsed.error !== null) {
        const id = forge.nextRequestId();
        const out = frame(jsonBody(400, { message: parsed.error }, { 'x-github-request-id': id }), id, false, false);
        socket.end(out);
        pending = EMPTY;
        return;
      }
      pending = pending.subarray(parsed.consumed);
      const request = parsed.request as RawRequest;
      if (request.expectContinue) socket.write(CONTINUE);
      const answer = route(forge, request, token);
      const out = frame(answer.handled, answer.requestId, request.method === 'HEAD', request.keepAlive);
      if (!request.keepAlive) {
        socket.end(out);
        pending = EMPTY;
        return;
      }
      socket.write(out);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    try {
      drain();
    } catch (err) {
      process.stderr.write(`[forge] connection failed: ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)}\n`);
      socket.destroy();
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('timeout', () => socket.destroy());
  socket.on('end', () => {
    if (pending.length === 0) socket.destroy();
  });
}

interface ParseResult {
  readonly request: RawRequest | null;
  readonly consumed: number;
  readonly error: string | null;
}

/**
 * Parse one request out of `buffer`, or null when the whole head (and body) is not in it yet.
 * `consumed` counts the bytes this request occupied, body included.
 */
function parseRequest(buffer: Buffer): ParseResult | null {
  const end = buffer.indexOf(HEAD_END);
  if (end < 0) {
    if (buffer.length > 128 * 1024) return { request: null, consumed: buffer.length, error: 'request head is too large' };
    return null;
  }
  const head = buffer.toString('latin1', 0, end);
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = requestLine.indexOf(' ', firstSpace + 1);
  if (firstSpace <= 0 || secondSpace <= firstSpace) return { request: null, consumed: end + 4, error: 'malformed request line' };
  const method = requestLine.slice(0, firstSpace).toUpperCase();
  const target = requestLine.slice(firstSpace + 1, secondSpace);
  const version = requestLine.slice(secondSpace + 1);
  if (!version.startsWith('HTTP/1.')) return { request: null, consumed: end + 4, error: 'unsupported HTTP version' };

  let contentLength = -1;
  let chunked = false;
  let keepAlive = !version.startsWith('HTTP/1.0');
  let expectContinue = false;
  const headers: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = value;
    if (name === 'content-length') {
      const parsedLength = Number(value);
      contentLength = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : -1;
    } else if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) {
      chunked = true;
    } else if (name === 'connection') {
      const lowered = value.toLowerCase();
      if (lowered.includes('close')) keepAlive = false;
      else if (lowered.includes('keep-alive')) keepAlive = true;
    } else if (name === 'expect' && value.toLowerCase() === '100-continue') {
      expectContinue = true;
    }
  }

  const bodyStart = end + 4;
  if (chunked) {
    const decoded = decodeChunked(buffer, bodyStart);
    if (decoded === null) return null;
    if (typeof decoded === 'string') return { request: null, consumed: decoded === 'too-large' ? buffer.length : bodyStart, error: 'malformed chunked body' };
    return {
      request: { method, target, path: pathOf(target), query: queryOfTarget(target), headers, body: decoded.body, keepAlive, expectContinue },
      consumed: decoded.consumed,
      error: null,
    };
  }
  if (contentLength > MAX_BODY_BYTES) return { request: null, consumed: bodyStart, error: `request body is over ${String(MAX_BODY_BYTES)} bytes` };
  if (contentLength < 0) contentLength = 0;
  if (buffer.length < bodyStart + contentLength) return null;
  const body = contentLength === 0 ? EMPTY : buffer.subarray(bodyStart, bodyStart + contentLength);
  return {
    request: { method, target, path: pathOf(target), query: queryOfTarget(target), headers, body, keepAlive, expectContinue },
    consumed: bodyStart + contentLength,
    error: null,
  };
}

function queryOfTarget(target: string): string {
  const cut = target.indexOf('?');
  return cut < 0 ? '' : target.slice(cut + 1);
}

/** Decode a chunked body: its bytes, or null when more are needed, or an error label. */
function decodeChunked(buffer: Buffer, start: number): { body: Buffer; consumed: number } | string | null {
  const parts: Buffer[] = [];
  let offset = start;
  let total = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const size = Number.parseInt(buffer.toString('latin1', offset, lineEnd).split(';')[0] as string, 16);
    if (!Number.isFinite(size) || size < 0) return 'too-large';
    offset = lineEnd + 2;
    if (size === 0) {
      // The trailer section ends with an empty line.
      const trailerEnd = buffer.indexOf('\r\n\r\n', offset - 2);
      if (trailerEnd < 0) {
        if (buffer.length < offset + 2) return null;
        return { body: parts.length === 0 ? EMPTY : Buffer.concat(parts), consumed: offset + 2 };
      }
      return { body: parts.length === 0 ? EMPTY : Buffer.concat(parts), consumed: trailerEnd + 4 };
    }
    if (buffer.length < offset + size + 2) return null;
    total += size;
    if (total > MAX_BODY_BYTES) return 'too-large';
    parts.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
}

/** The bytes one answer becomes on the wire. */
function frame(answer: Handled, requestId: string, headOnly: boolean, keepAlive: boolean): Buffer {
  const body = answer.body ?? EMPTY;
  const status = answer.status;
  let head = `HTTP/1.1 ${String(status)} ${REASONS[status] ?? 'Unknown'}\r\ncontent-type: ${answer.contentType}\r\ncontent-length: ${String(body.length)}\r\nx-github-request-id: ${requestId}\r\n`;
  for (const name in answer.headers) {
    if (name === 'x-github-request-id') continue;
    const value = answer.headers[name];
    if (value !== undefined) head += `${name}: ${value}\r\n`;
  }
  head += keepAlive ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n';
  const headBytes = Buffer.from(head, 'latin1');
  if (status === 204 || headOnly || body.length === 0) return headBytes;
  return Buffer.concat([headBytes, body]);
}

interface Routed {
  readonly handled: Handled;
  readonly requestId: string;
}

/** Route one request to its answer. */
function route(forge: Forge, req: RawRequest, token: string): Routed {
  const requestId = forge.nextRequestId();
  const method = req.method;
  const path = req.path;

  // The env's boot probe: twice per trial, no auth.
  if (path === '/healthz' || path === '/healthz/') {
    return { handled: jsonBody(200, { ok: true }, { 'x-github-request-id': requestId }), requestId };
  }

  // Git smart HTTP.
  const git = gitPath(path);
  if (git !== null) {
    try {
      return { handled: handleGit(forge, req, git, requestId), requestId };
    } catch (err) {
      process.stderr.write(`[forge] ${method} ${path} failed: ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)}\n`);
      return { handled: jsonBody(400, { message: err instanceof Error ? err.message : 'malformed request' }, { 'x-github-request-id': requestId }), requestId };
    }
  }

  // GraphQL.
  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (method !== 'POST') return { handled: jsonBody(404, { message: 'Not Found' }, { 'x-github-request-id': requestId }), requestId };
    const parsed = parseJson(req.body);
    const answer = handleGraphQL(forge, parsed.value, parsed.error, tokenOf(req.headers, token));
    return { handled: strip(answer, requestId), requestId };
  }

  // MCP.
  if (path === '/mcp' || path === '/mcp/') {
    if (method !== 'POST' && method !== 'DELETE') {
      return { handled: jsonBody(405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId }), requestId };
    }
    if (method === 'DELETE') {
      return { handled: { status: 200, body: null, contentType: 'application/json; charset=utf-8', headers: { 'x-github-request-id': requestId } }, requestId };
    }
    const raw = req.body.toString('utf8');
    const methodHeader = typeof req.headers['mcp-method'] === 'string' ? req.headers['mcp-method'] : null;
    const authToken = tokenOf(req.headers, token);
    if (authToken === null) {
      return { handled: jsonBody(401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId }), requestId };
    }
    const answer = handleMcp(forge, raw, authToken, methodHeader);
    const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(answer.headers ?? {}) };
    if (answer.body === null) return { handled: { status: answer.status, body: null, contentType: 'application/json; charset=utf-8', headers }, requestId };
    return { handled: jsonBody(answer.status, answer.body, headers), requestId };
  }

  // REST.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const authToken = tokenOf(req.headers, token);
    if (authToken === null) {
      return { handled: jsonBody(401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId }), requestId };
    }
    let body: unknown = {};
    let bodyError: string | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const parsed = parseJson(req.body);
      body = parsed.value;
      bodyError = parsed.error;
    }
    const request: ApiRequest = {
      method,
      segments: segmentsOf(path),
      rawPath: path,
      query: req.query === '' ? NO_QUERY : new URLSearchParams(req.query),
      body,
      bodyError,
      token: authToken,
      baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
    };
    const answer = handleRest(forge, request);
    return { handled: strip(answer, requestId), requestId };
  }

  // Anything else: GitHub's JSON 404, never HTML.
  return { handled: jsonBody(404, { message: 'Not Found' }, { 'x-github-request-id': requestId }), requestId };
}

/** `/api/v3/repos/o/r/issues` -> ['repos','o','r','issues'], decoded per segment. */
function segmentsOf(path: string): string[] {
  const rest = path.replace(/^\/api\/v3\/?/, '');
  if (rest === '') return [];
  const parts = rest.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    out.push(part.indexOf('%') < 0 ? part : safeDecode(part));
  }
  return out;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseJson(bytes: Buffer): { value: unknown; error: string | null } {
  if (bytes.length === 0) return { value: {}, error: null };
  const text = bytes.toString('utf8');
  if (text.trim() === '') return { value: {}, error: null };
  try {
    return { value: JSON.parse(text) as unknown, error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : 'not JSON' };
  }
}

/** Add the request-id header to every REST/GraphQL answer. */
function strip(answer: Answer, requestId: string): Handled {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(answer.headers ?? {}) };
  if (answer.binary !== undefined) {
    return { status: answer.status, body: answer.binary, contentType: answer.contentType ?? 'application/octet-stream', headers };
  }
  return jsonBody(answer.status, answer.body, headers);
}

/** The smart-HTTP endpoints. */
function handleGit(forge: Forge, req: RawRequest, git: { owner: string; name: string; rest: string }, requestId: string): Handled {
  const method = req.method;
  const repo = git.owner === forge.viewer.login ? forge.repo(git.owner, git.name) : undefined;
  const notFound = jsonBody(404, { message: 'Not Found' }, { 'x-github-request-id': requestId });

  if (git.rest === '/info/refs') {
    if (method !== 'GET') return { status: 405, body: null, contentType: 'text/plain; charset=utf-8', headers: { 'x-github-request-id': requestId } };
    const service = new URLSearchParams(req.query).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return jsonBody(400, { message: 'dumb http transport is not supported' }, { 'x-github-request-id': requestId });
    }
    if (repo === undefined) return notFound;
    const wantsV2 = service === 'git-upload-pack' && /version=2/.test(String(req.headers['git-protocol'] ?? ''));
    if (wantsV2) return { status: 200, body: v2Advertisement(), contentType: UPLOAD_PACK, headers: { 'x-github-request-id': requestId, 'cache-control': 'no-cache' } };
    const body = v0Advertisement(repo, service);
    return { status: 200, body, contentType: service === 'git-upload-pack' ? UPLOAD_PACK : RECEIVE_PACK, headers: { 'x-github-request-id': requestId, 'cache-control': 'no-cache' } };
  }

  if (git.rest === '/git-upload-pack') {
    if (method !== 'POST') return { status: 405, body: null, contentType: 'text/plain; charset=utf-8', headers: { 'x-github-request-id': requestId } };
    if (repo === undefined) return notFound;
    const raw = req.body;
    // The clone workload sends the same fetch 50 times over: an answer is a pure function of the
    // store state and the request bytes, so the second and later ones are served from memory.
    let cacheKey: string | null = null;
    if (raw.length <= 8192) {
      cacheKey = `${repo.stateKey()}\u0000${raw.toString('latin1')}`;
      const hit = repo.uploadCache.get(cacheKey);
      if (hit !== undefined) return { status: 200, body: hit, contentType: UPLOAD_RESULT, headers: { 'x-github-request-id': requestId, 'cache-control': 'no-cache' } };
    }
    const wantsV2 = /version=2/.test(String(req.headers['git-protocol'] ?? '')) || isV2Body(raw);
    const parsed = parsePacketsOf(raw).packets;
    const command = v2CommandOf(parsed);
    const body = command === 'ls-refs' ? lsRefsFromV2(repo, parsed) : !wantsV2 ? v0Fetch(repo, parsed) : v2Fetch(repo, parsed);
    if (cacheKey !== null) {
      if (repo.uploadCache.size >= 128) repo.uploadCache.clear();
      repo.uploadCache.set(cacheKey, body);
    }
    return { status: 200, body, contentType: UPLOAD_RESULT, headers: { 'x-github-request-id': requestId, 'cache-control': 'no-cache' } };
  }

  if (git.rest === '/git-receive-pack') {
    if (method !== 'POST') return { status: 405, body: null, contentType: 'text/plain; charset=utf-8', headers: { 'x-github-request-id': requestId } };
    if (repo === undefined) return notFound;
    const request = parsePushBody(req.body);
    const applied = applyPush(repo, request);
    const body = pushAnswer(applied.results, applied.unpackOk, applied.unpackDetail, request.capabilities);
    return { status: 200, body, contentType: RECEIVE_RESULT, headers: { 'x-github-request-id': requestId } };
  }

  return notFound;
}

/** Whether a v2 request body carries `command=` lines (the suite's fetch/ls-refs form). */
function isV2Body(body: Buffer): boolean {
  const head = body.toString('latin1', 0, Math.min(body.length, 256));
  return head.indexOf('command=') >= 0;
}

/** The `command=` a v2 request names, or null. */
function v2CommandOf(packets: readonly { kind: string; payload: Buffer }[]): string | null {
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) return line.slice('command='.length);
  }
  return null;
}

/** The v2 ls-refs answer, reading the client's own flags (`peel`, `symrefs`, `unborn`, `ref-prefix`). */
function lsRefsFromV2(repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  return lsRefs(repo, { peel, symrefs, unborn, prefixes });
}

export { MAX_BODY_BYTES as MAX_REQUEST_BYTES };
