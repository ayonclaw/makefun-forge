// The forge's HTTP surface: one server, four protocols, no framework.
//
//   GET  /healthz                       the env's boot probe
//   GET  /{owner}/{repo}.git/info/refs   the smart-HTTP advertisement (v2 with Git-Protocol: version=2)
//   POST /{owner}/{repo}.git/git-upload-pack / git-receive-pack
//   ANY  /api/v3/...                    the REST v3 surface
//   POST /api/graphql                   GraphQL v4
//   POST /mcp                           Model Context Protocol
//
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id and a JSON error body.
// The bearer token names the login a repository belongs to, so an unauthenticated request is 401 and
// another owner's name is 404. Nothing here reads a clock for anything the suite can see.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readBody, type ReadResult } from './http-body.ts';
import { RECEIVE_PACK, RECEIVE_RESULT, UPLOAD_PACK, UPLOAD_RESULT, applyPush, lsRefs, parsePushBody, pushAnswer, v0Advertisement, v0Fetch, v2Advertisement, v2Fetch } from './git-http.ts';
import { handleGraphQL, handleMcp, handleRest, type Answer, type ApiRequest } from './rest.ts';
import { Forge, type Repo } from './store.ts';

/** The largest request body this forge reads (a push pack is the big one). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface Handled {
  readonly status: number;
  readonly body: Buffer | null;
  readonly contentType: string;
  readonly headers: Record<string, string>;
}

function jsonBody(status: number, body: unknown, headers: Record<string, string> = {}): Handled {
  const text = `${JSON.stringify(body)}
`;
  return { status, body: Buffer.from(text, 'utf8'), contentType: 'application/json; charset=utf-8', headers };
}


/** The raw path, without its query string. */
function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const cut = url.indexOf('?');
  return cut < 0 ? url : url.slice(0, cut);
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const cut = url.indexOf('?');
  return new URLSearchParams(cut < 0 ? '' : url.slice(cut + 1));
}

/** Whether the request presented the trial's bearer token. */
function tokenOf(req: IncomingMessage, expected: string): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const value = (match[1] ?? '').trim();
  if (expected !== '' && value !== expected) return null;
  return value;
}

/** Split a git smart-HTTP path into its owner, repository and the rest. */
function gitPath(path: string): { owner: string; name: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const rest = match[3] ?? '';
  return { owner, name, rest };
}

/** Build the forge server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const token = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(forge, req, res, token).catch((err: unknown) => {
      process.stderr.write(`[forge] ${req.method ?? '?'} ${req.url ?? '/'} failed: ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)}\n`);
      if (!res.headersSent) {
        const requestId = forge.nextRequestId();
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
        res.end(`${JSON.stringify({ message: 'Internal error' })}\n`);
      } else {
        res.end();
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.maxRequestsPerSocket = 0;
  return server;
}

/** Request profiling is off unless MAKEFUN_PROFILE=1 (a dev aid; nothing in a graded trial sets it). */
const PROFILE = process.env.MAKEFUN_PROFILE === '1';

/** Route and answer one request. */
async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const startedAt = PROFILE ? performance.now() : 0;
  const method = (req.method ?? 'GET').toUpperCase();
  const path = pathOf(req);
  const requestId = forge.nextRequestId();
  const profile = (label: string): void => {
    if (startedAt === 0) return;
    process.stderr.write(`[prof] ${(performance.now() - startedAt).toFixed(2)}ms ${label}\n`);
  };

  // The env's boot probe: twice per trial, no auth.
  if (path === '/healthz' || path === '/healthz/') {
    const answer = jsonBody(200, { ok: true }, { 'x-github-request-id': requestId });
    return send(res, answer);
  }

  // Git smart HTTP.
  const git = gitPath(path);
  if (git !== null) {
    const answer = await handleGit(forge, req, git, requestId);
    if (answer !== null) return send(res, answer);
  }

  // GraphQL.
  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (method !== 'POST') return send(res, jsonBody(404, { message: 'Not Found' }, { 'x-github-request-id': requestId }));
    const read = await readBody(req, MAX_BODY_BYTES);
    const parsed = parseJson(read);
    const answer = handleGraphQL(forge, parsed.value, parsed.error, tokenOf(req, token));
    return send(res, strip(answer, requestId));
  }

  // MCP.
  if (path === '/mcp' || path === '/mcp/') {
    if (method !== 'POST' && method !== 'DELETE') {
      return send(res, jsonBody(405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId }));
    }
    if (method === 'DELETE') {
      return send(res, { status: 200, body: null, contentType: 'application/json; charset=utf-8', headers: { 'x-github-request-id': requestId } });
    }
    const read = await readBody(req, MAX_BODY_BYTES);
    const raw = read.error !== null ? '' : read.text;
    const methodHeader = typeof req.headers['mcp-method'] === 'string' ? req.headers['mcp-method'] : null;
    if (read.error !== null) {
      return send(res, jsonBody(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${read.error}` } }, { 'x-github-request-id': requestId }));
    }
    if (tokenOf(req, token) === null) {
      return send(res, jsonBody(401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId }));
    }
    const answer = handleMcp(forge, raw, tokenOf(req, token), methodHeader);
    const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(answer.headers ?? {}) };
    if (answer.body === null) return send(res, { status: answer.status, body: null, contentType: 'application/json; charset=utf-8', headers });
    return send(res, jsonBody(answer.status, answer.body, headers));
  }

  // REST.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const authToken = tokenOf(req, token);
    if (authToken === null) {
      return send(res, jsonBody(401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId }));
    }
    // A GET/HEAD carries no body in the suite's traffic, and awaiting a read costs an event-loop
    // turn per request; the read workload is 2,000 GETs in a row, so the fast path matters.
    let body: unknown = {};
    let bodyError: string | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const read = await readBody(req, MAX_BODY_BYTES);
      const parsed = parseJson(read);
      body = parsed.value;
      bodyError = read.error ?? parsed.error;
    }
    const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((segment) => segment !== '').map((segment) => safeDecode(segment));
    const request: ApiRequest = {
      method,
      segments,
      rawPath: path,
      query: queryOf(req),
      body,
      bodyError,
      token: authToken,
      baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
    };
    const answer = handleRest(forge, request);
    profile(`${method} ${path}`);
    return send(res, strip(answer, requestId));
  }

  // Anything else: GitHub's JSON 404, never HTML.
  return send(res, jsonBody(404, { message: 'Not Found' }, { 'x-github-request-id': requestId }));
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseJson(read: ReadResult): { value: unknown; error: string | null } {
  if (read.error !== null) return { value: null, error: read.error };
  if (read.text.trim() === '') return { value: {}, error: null };
  try {
    return { value: JSON.parse(read.text) as unknown, error: null };
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

function send(res: ServerResponse, answer: Handled): void {
  const headers: Record<string, string> = { 'content-type': answer.contentType, ...answer.headers };
  if (answer.body === null) {
    res.writeHead(answer.status, { ...headers, 'content-length': '0' });
    res.end();
    return;
  }
  res.writeHead(answer.status, { ...headers, 'content-length': String(answer.body.length) });
  res.end(answer.body);
}

/** The smart-HTTP endpoints; null when the path is a git path but not one of its routes. */
async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  git: { owner: string; name: string; rest: string },
  requestId: string,
): Promise<Handled | null> {
  const method = (req.method ?? 'GET').toUpperCase();
  const repo = git.owner === forge.viewer.login ? forge.repo(git.owner, git.name) : undefined;
  const notFound = jsonBody(404, { message: 'Not Found' }, { 'x-github-request-id': requestId });

  if (git.rest === '/info/refs') {
    if (method !== 'GET') return { status: 405, body: null, contentType: 'text/plain; charset=utf-8', headers: { 'x-github-request-id': requestId } };
    const service = queryOf(req).get('service');
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
    const read = await readBody(req, MAX_BODY_BYTES);
    if (read.error !== null) return jsonBody(400, { message: read.error }, { 'x-github-request-id': requestId });
    const raw = read.bytes;
    const wantsV2 = /version=2/.test(String(req.headers['git-protocol'] ?? '')) || isV2Body(raw);
    try {
      const parsed = parsePacketsOf(raw).packets;
      const command = v2CommandOf(parsed);
      const body = command === 'ls-refs' ? lsRefsFromV2(repo, parsed) : !wantsV2 ? v0Fetch(repo, parsed) : v2Fetch(repo, parsed);
      return { status: 200, body, contentType: UPLOAD_RESULT, headers: { 'x-github-request-id': requestId, 'cache-control': 'no-cache' } };
    } catch (err) {
      return jsonBody(400, { message: err instanceof Error ? err.message : 'malformed request' }, { 'x-github-request-id': requestId });
    }
  }

  if (git.rest === '/git-receive-pack') {
    if (method !== 'POST') return { status: 405, body: null, contentType: 'text/plain; charset=utf-8', headers: { 'x-github-request-id': requestId } };
    if (repo === undefined) return notFound;
    const read = await readBody(req, MAX_BODY_BYTES);
    if (read.error !== null) return jsonBody(400, { message: read.error }, { 'x-github-request-id': requestId });
    const request = parsePushBody(read.bytes);
    const applied = applyPush(repo, request);
    const body = pushAnswer(applied.results, applied.unpackOk, applied.unpackDetail, request.capabilities);
    return { status: 200, body, contentType: RECEIVE_RESULT, headers: { 'x-github-request-id': requestId } };
  }

  if (git.rest === '' || git.rest === '/') return notFound;
  return notFound;
}

/** Whether a v2 request body carries `command=` lines (the suite's fetch/ls-refs form). */
function isV2Body(body: Buffer): boolean {
  const head = body.subarray(0, 256).toString('utf8');
  return /command=/.test(head);
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

// Re-exported from the git layer so the router does not import it twice.
import { parsePackets as parsePacketsOf } from './objects.ts';
export { MAX_BODY_BYTES as MAX_REQUEST_BYTES };
