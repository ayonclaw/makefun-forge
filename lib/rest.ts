// The GitHub REST v3 surface under /api/v3, plus the GraphQL and MCP endpoints.
//
// One router, no framework: every reply is JSON with a non-empty X-GitHub-Request-Id, an error
// carries `{"message": string}`, and a repository belongs to the login the bearer token names — so
// the same name under another owner is a 404, never a 403.

import { createHash } from 'node:crypto';
import type { Forge, Label, Pull, Repo } from './store.ts';
import {
  branchView,
  commitJson,
  commentView,
  createComment,
  createIssue,
  issueView,
  labelView,
  mergePullRequest,
  pullFiles,
  pullView,
  refTip,
  refView,
  repoView,
} from './views.ts';
import { executeGraphQL } from './graphql.ts';
import { handleRpc } from './mcp.ts';
import { isOid } from './objects.ts';

/** The result of handling one request, before framing. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly binary?: Buffer;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

/** A request as the router reads it. */
export interface ApiRequest {
  readonly method: string;
  /** The URL's pathname, decoded per segment. */
  readonly segments: string[];
  /** The raw path, for a response body's url fields. */
  readonly rawPath: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** Why the body could not be parsed as JSON, when it could not. */
  readonly bodyError: string | null;
  /** The bearer token the request presented, or null. */
  readonly token: string | null;
  readonly baseUrl: string;
}

const MESSAGE = (message: string): Record<string, unknown> => ({ message, documentation_url: 'https://docs.github.com/rest' });

/** A repository belongs to the token's login: this answers it or a 404. */
function reach(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== forge.viewer.login) return null;
  return forge.repo(owner, name) ?? null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/** The `Link: <...>; rel="next"` header a paged answer carries when more items follow. */
function linkHeader(request: ApiRequest, total: number, perPage: number, pageNumber: number): string | null {
  if (pageNumber * perPage >= total) return null;
  const next = new URL(request.baseUrl + request.rawPath);
  next.searchParams.set('page', String(pageNumber + 1));
  next.searchParams.set('per_page', String(perPage));
  const last = Math.max(1, Math.ceil(total / perPage));
  const lastUrl = new URL(next);
  lastUrl.searchParams.set('page', String(last));
  return `<${next.toString()}>; rel="next", <${lastUrl.toString()}>; rel="last"`;
}

/** The labels a request asked for, resolving each against the repository (a miss is a 422). */
function resolveLabels(repo: Repo, labels: unknown, numbers: unknown): { labels: Label[]; missing: string[] } {
  const resolved: Label[] = [];
  const missing: string[] = [];
  const wanted: string[] = [];
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      if (typeof entry === 'string') wanted.push(entry);
      else if (entry !== null && typeof entry === 'object') {
        const name = (entry as { name?: unknown }).name;
        if (typeof name === 'string') wanted.push(name);
      }
    }
  }
  if (Array.isArray(numbers)) {
    for (const entry of numbers) {
      const value = num(entry);
      const label = [...repo.labels.values()][(value ?? 1) - 1];
      if (label !== undefined) wanted.push(label.name);
    }
  }
  for (const name of wanted) {
    const label = repo.labels.get(name);
    if (label === undefined) missing.push(name);
    else resolved.push(label);
  }
  return { labels: resolved, missing };
}

/**
 * Handle one /api/v3 request. Everything the surface answers lives here: the same function serves
 * every route so the status/JSON/header discipline is one code path.
 */
export function handleRest(forge: Forge, request: ApiRequest): Answer {
  const { segments, method, query } = request;
  const viewer = forge.viewer;
  const root = (body: unknown, headers: Record<string, string> = {}): Answer => ({ status: 200, body, headers });

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return { status: 404, body: MESSAGE('Not Found') };
    return root(
      {
        current_user_url: `${request.baseUrl}/api/v3/user`,
        repository_url: `${request.baseUrl}/api/v3/repos/{owner}/{repo}`,
        user_repositories_url: `${request.baseUrl}/api/v3/user/repos{?type,page,per_page,sort}`,
        rate_limit_url: `${request.baseUrl}/api/v3/rate_limit`,
        emojis_url: `${request.baseUrl}/api/v3/emojis`,
        hub_url: `${request.baseUrl}/api/v3/hub`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    return root({ installed_version: '3.0.0-makefun', verifiable_password_authentication: false, hooks: [], git: ['2.43.0'], ssh_key_fingerprints: {} });
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      return root({ login: viewer.login, id: 1000, node_id: `MDQ6VXNlcjEwMDA=`, name: viewer.name, email: viewer.email, type: 'User', site_admin: false });
    }
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const all = forge.reposOf(viewer.login);
        const type = query.get('type') ?? 'owner';
        const visible = type === 'private' ? all.filter((repo) => repo.private) : type === 'public' ? all.filter((repo) => !repo.private) : all;
        const perPage = Math.max(1, Math.min(100, num(query.get('per_page')) ?? 30));
        const pageNumber = Math.max(1, num(query.get('page')) ?? 1);
        const items = visible.slice((pageNumber - 1) * perPage, pageNumber * perPage).map((repo) => repoView(repo, request.baseUrl));
        const link = linkHeader(request, visible.length, perPage, pageNumber);
        return root(items, link === null ? {} : { link });
      }
      if (method === 'POST') {
        if (request.bodyError !== null) return { status: 400, body: MESSAGE('Problems parsing JSON') };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const name = str(body.name);
        if (name === '') return { status: 422, body: MESSAGE('Repository creation failed: a name is required') };
        const created = forge.createRepo(viewer.login, name, str(body.description), bool(body.private), '2025-01-01T00:00:00Z');
        if (created === undefined) return { status: 422, body: MESSAGE('Repository creation failed: name already exists on this account') };
        return { status: 201, body: repoView(created, request.baseUrl) };
      }
      return { status: 405, body: MESSAGE('Method Not Allowed') };
    }
    if (segments.length === 1) return { status: 404, body: MESSAGE('Not Found') };
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = reach(forge, owner, name);
    const rest = segments.slice(3);
    if (repo === null) return { status: 404, body: MESSAGE('Not Found') };
    return handleRepo(forge, request, repo, rest);
  }

  if (segments[0] === 'rate_limit') {
    return root({ resources: { core: { limit: 5000, remaining: 4999, reset: 1767225600 } }, rate: { limit: 5000, remaining: 4999, reset: 1767225600 } });
  }

  return { status: 404, body: MESSAGE('Not Found') };
}

/** The routes under /api/v3/repos/{owner}/{repo}. */
function handleRepo(forge: Forge, request: ApiRequest, repo: Repo, rest: string[]): Answer {
  const { method, query } = request;
  const at = (index: number): string => rest[index] ?? '';

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoView(repo, request.baseUrl) };
    if (method === 'PATCH') {
      if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) repo.rename(body.name);
      return { status: 200, body: repoView(repo, request.baseUrl) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  // /repos/{o}/{r}/branches[/{branch}]
  if (at(0) === 'branches') {
    const branches = repo.branches();
    if (rest.length === 1) {
      if (method === 'GET') return { status: 200, body: branches.map((branch) => branchView(branch, repo, request.baseUrl)) };
      return { status: 405, body: { message: 'Method Not Allowed' } };
    }
    const wanted = branches.find((branch) => branch.name === at(1));
    if (wanted === undefined) return { status: 404, body: { message: 'Branch not found' } };
    if (method === 'GET') return { status: 200, body: branchView(wanted, repo, request.baseUrl) };
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  // /repos/{o}/{r}/commits[/{sha}]
  if (at(0) === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? (isOid(ref) ? ref : undefined);
      const commits = repo.commitsFrom(tip);
      const perPage = Math.max(1, Math.min(100, num(query.get('per_page')) ?? 30));
      const pageNumber = Math.max(1, num(query.get('page')) ?? 1);
      const slice = commits.slice((pageNumber - 1) * perPage, pageNumber * perPage);
      const link = linkHeader(request, commits.length, perPage, pageNumber);
      return { status: 200, body: slice.map((commit) => commitJson(commit, repo, request.baseUrl)), headers: link === null ? {} : { link } };
    }
    const commit = repo.commitsFrom(undefined).length === 0 ? undefined : undefined;
    void commit;
    const wanted = repo.objects.get(at(1));
    if (wanted === undefined || wanted.type !== 'commit') return { status: 404, body: { message: 'Commit not found' } };
    const parsed = repo.commitsFrom(at(1)).find((entry) => entry.oid === at(1));
    if (parsed === undefined) return { status: 404, body: { message: 'Commit not found' } };
    return { status: 200, body: commitJson(parsed, repo, request.baseUrl) };
  }

  // /repos/{o}/{r}/git/refs[...]
  if (at(0) === 'git' && at(1) === 'refs') {
    return handleRefs(request, repo, rest.slice(2));
  }
  if (at(0) === 'git' && at(1) === 'commits' && rest.length === 3) {
    const parsed = repo.commitsFrom(at(2)).find((entry) => entry.oid === at(2));
    if (parsed === undefined) return { status: 404, body: { message: 'Commit not found' } };
    return { status: 200, body: commitJson(parsed, repo, request.baseUrl) };
  }
  if (at(0) === 'git' && at(1) === 'trees' && rest.length === 3) {
    const tree = repo.objects.get(at(2));
    if (tree === undefined || tree.type !== 'tree') return { status: 404, body: { message: 'Tree not found' } };
    return { status: 200, body: { sha: at(2), tree: [] } };
  }

  // /repos/{o}/{r}/contents/{path...}
  if (at(0) === 'contents') {
    return handleContents(forge, request, repo, rest.slice(1));
  }

  // /repos/{o}/{r}/labels
  if (at(0) === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label, index) => labelView(label, index)) };
      if (method === 'POST') {
        if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const name = str(body.name);
        if (name === '') return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] } };
        const label: Label = { name, color: str(body.color, 'ededed') };
        repo.labels.set(name, label);
        return { status: 201, body: labelView(label, repo.labels.size - 1) };
      }
      return { status: 405, body: { message: 'Method Not Allowed' } };
    }
    const label = repo.labels.get(at(1));
    if (label === undefined) return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET') return { status: 200, body: labelView(label, [...repo.labels.keys()].indexOf(label.name)) };
    if (method === 'DELETE') {
      repo.labels.delete(label.name);
      return { status: 204, body: null };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  // /repos/{o}/{r}/issues[/{number}[/comments]]
  if (at(0) === 'issues') {
    return handleIssues(forge, request, repo, rest.slice(1));
  }

  // /repos/{o}/{r}/pulls[/{number}[/files|/merge]]
  if (at(0) === 'pulls') {
    return handlePulls(forge, request, repo, rest.slice(1));
  }

  return { status: 404, body: { message: 'Not Found' } };
}

/** The Git Data refs routes. */
function handleRefs(request: ApiRequest, repo: Repo, rest: string[]): Answer {
  const { method } = request;
  if (rest.length === 0) {
    if (method === 'GET') {
      const head = repo.head();
      const refs = repo.refList();
      return { status: 200, body: [...(head === undefined ? [] : [{ ref: 'refs/heads/' + repo.defaultBranch, object: { sha: head, type: 'commit' } }]), ...refs.map((ref) => ({ ref: ref.name, object: { sha: ref.oid, type: 'commit' } }))] };
    }
    if (method === 'POST') {
      if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const ref = str(body.ref);
      const sha = str(body.sha);
      let name = ref;
      if (!name.startsWith('refs/')) name = `refs/heads/${name}`;
      if (name === '' || !isOid(sha) || !repo.objects.has(sha)) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Ref', field: 'sha', code: 'invalid' }] } };
      if (repo.refs.has(name)) return { status: 422, body: { message: 'Reference already exists' } };
      repo.refs.set(name, sha);
      return { status: 201, body: refView(name, sha, repo, request.baseUrl) };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }
  let name = rest.join('/');
  if (!name.startsWith('refs/')) name = `refs/${name.startsWith('heads/') || name.startsWith('tags/') ? name : `heads/${name}`}`;
  const current = repo.refs.get(name);
  if (current === undefined) return { status: 404, body: { message: 'Not Found' } };
  if (method === 'GET') return { status: 200, body: refView(name, current, repo, request.baseUrl) };
  if (method === 'PATCH') {
    if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sha = str(body.sha);
    if (!isOid(sha) || !repo.objects.has(sha)) return { status: 422, body: { message: 'Validation Failed' } };
    repo.refs.set(name, sha);
    return { status: 200, body: refView(name, sha, repo, request.baseUrl) };
  }
  if (method === 'DELETE') {
    repo.refs.delete(name);
    return { status: 204, body: null };
  }
  return { status: 405, body: { message: 'Method Not Allowed' } };
}

/** The contents routes: a file GET, a directory listing, a PUT and a DELETE. */
function handleContents(forge: Forge, request: ApiRequest, repo: Repo, rest: string[]): Answer {
  const { method, query } = request;
  const viewer = forge.viewer;
  const path = rest.join('/');
  const ref = query.get('ref') ?? undefined;
  const refTipOid = (): string | undefined => {
    if (ref === undefined) return repo.head();
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? (isOid(ref) ? ref : undefined);
  };

  if (method === 'GET') {
    const tip = refTipOid();
    if (tip === undefined) return { status: 404, body: { message: 'Not Found' } };
    const entry = repo.entryAt(tip, path);
    if (entry !== null && entry.mode !== '40000') {
      const blob = repo.objects.get(entry.oid);
      const text = blob === undefined ? '' : blob.data.toString('utf8');
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: blob === undefined ? 0 : blob.data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: Buffer.from(text, 'utf8').toString('base64'),
          sha: entry.oid,
          url: `${request.baseUrl}/api/v3/repos/${repo.fullName}/contents/${path}`,
          git_url: `${request.baseUrl}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
          html_url: null,
          download_url: null,
        },
      };
    }
    // A directory listing, or the repository root.
    const prefix = path === '' ? '' : `${path}/`;
    const listing: unknown[] = [];
    const seen = new Set<string>();
    for (const [filePath, oid] of repo.paths(tip)) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const head = remainder.split('/')[0] as string;
      if (head === '' || seen.has(head)) continue;
      seen.add(head);
      const isDir = remainder.includes('/');
      const childPath = `${prefix}${head}`;
      const childOid = isDir ? repo.entryAt(tip, childPath)?.oid ?? oid : oid;
      const blob = repo.objects.get(childOid);
      listing.push({
        type: isDir ? 'dir' : 'file',
        size: blob === undefined ? 0 : blob.data.length,
        name: head,
        path: childPath,
        sha: childOid,
        url: `${request.baseUrl}/api/v3/repos/${repo.fullName}/contents/${childPath}`,
        html_url: null,
        download_url: null,
      });
    }
    if (listing.length === 0 && path !== '') return { status: 404, body: { message: 'Not Found' } };
    return { status: 200, body: listing };
  }

  if (method === 'PUT') {
    if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const message = str(body.message, `Update ${path}`);
    const contentBase64 = str(body.content);
    const branch = str(body.branch) || repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined && branch !== repo.defaultBranch) return { status: 404, body: { message: 'Branch not found' } };
    const current = tip === undefined ? null : repo.entryAt(tip, path);
    const existingSha = current === null || current.mode === '40000' ? null : current.oid;
    const sentSha = str(body.sha);
    const isUpdate = existingSha !== null;
    if (isUpdate && sentSha !== '' && sentSha !== existingSha) {
      return { status: 409, body: { message: `${path} does not match ${sentSha}` } };
    }
    if (!isUpdate && sentSha !== '') {
      return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'sha', code: 'invalid' }] } };
    }
    let data: Buffer;
    try {
      data = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    } catch {
      return { status: 400, body: { message: 'content is not valid base64' } };
    }
    const commit = repo.writeCommit({ parents: tip === undefined ? [] : [tip], message, author: viewer, set: [{ path, content: data }] });
    repo.refs.set(branchRef, commit);
    const blob = repo.objects.get(repo.entryAt(commit, path)?.oid ?? '');
    return {
      status: isUpdate ? 200 : 201,
      body: {
        content: { sha: blob === undefined ? '' : hashOf(blob.data), encoding: 'base64' },
        commit: { sha: commit, url: `${request.baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${commit}` },
      },
    };
  }

  if (method === 'DELETE') {
    if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tip = repo.head();
    if (tip === undefined) return { status: 404, body: { message: 'Not Found' } };
    const entry = repo.entryAt(tip, path);
    if (entry === null) return { status: 404, body: { message: 'Not Found' } };
    const sentSha = str(body.sha);
    if (sentSha !== '' && sentSha !== entry.oid) return { status: 409, body: { message: `${path} does not match ${sentSha}` } };
    const commit = repo.writeCommit({ parents: [tip], message: str(body.message, `Delete ${path}`), author: viewer, remove: [path] });
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
    return { status: 200, body: { commit: { sha: commit }, content: null } };
  }

  return { status: 405, body: { message: 'Method Not Allowed' } };
}

function hashOf(data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${String(data.length)}\u0000`, 'utf8'), data])).digest('hex');
}

/** The issue routes. */
function handleIssues(forge: Forge, request: ApiRequest, repo: Repo, rest: string[]): Answer {
  const { method, query } = request;
  const viewer = forge.viewer;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const labels = (query.get('labels') ?? '').split(',').filter((name) => name !== '');
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (labels.length > 0) issues = issues.filter((issue) => labels.every((name) => issue.labels.some((label) => label.name === name)));
      issues = issues.sort((a, b) => {
        const order = sort === 'updated' ? a.number - b.number : a.number - b.number;
        return direction === 'asc' ? order : -order;
      });
      const perPage = Math.max(1, Math.min(100, num(query.get('per_page')) ?? 30));
      const pageNumber = Math.max(1, num(query.get('page')) ?? 1);
      const slice = issues.slice((pageNumber - 1) * perPage, pageNumber * perPage);
      const link = linkHeader(request, issues.length, perPage, pageNumber);
      return { status: 200, body: slice.map((issue) => issueView(issue, repo, request.baseUrl)), headers: link === null ? {} : { link } };
    }
    if (method === 'POST') {
      if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const title = str(body.title);
      if (title === '') return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] } };
      const resolved = resolveLabels(repo, body.labels, body.label_ids);
      if (resolved.missing.length > 0) {
        return { status: 422, body: { message: 'Validation Failed', errors: resolved.missing.map((name) => ({ resource: 'Label', field: 'name', code: 'missing', value: name })) } };
      }
      const issue = createIssue(repo, forge, { title, body: str(body.body), labels: resolved.labels, user: viewer, createdAt: '2025-01-01T00:00:00Z' });
      return { status: 201, body: issueView(issue, repo, request.baseUrl) };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  const number = num(rest[0]);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (rest.length === 1) {
    if (issue === undefined) return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET') return { status: 200, body: issueView(issue, repo, request.baseUrl) };
    if (method === 'PATCH') {
      if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') (issue as { title: string }).title = body.title;
      if (typeof body.body === 'string') (issue as { body: string }).body = body.body;
      if (body.state === 'closed') {
        issue.state = 'closed';
        issue.closedAt = '2025-01-01T00:00:00Z';
      } else if (body.state === 'open') {
        issue.state = 'open';
        issue.closedAt = null;
      }
      if (body.labels !== undefined) {
        const resolved = resolveLabels(repo, body.labels, body.label_ids);
        if (resolved.missing.length > 0) return { status: 422, body: { message: 'Validation Failed' } };
        issue.labels.length = 0;
        issue.labels.push(...resolved.labels);
      }
      return { status: 200, body: issueView(issue, repo, request.baseUrl) };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  if (rest[1] === 'comments') {
    if (issue === undefined) return { status: 404, body: { message: 'Not Found' } };
    if (rest.length === 2) {
      if (method === 'GET') {
        return { status: 200, body: issue.comments.map((comment) => commentView(comment)) };
      }
      if (method === 'POST') {
        if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const comment = createComment(forge, issue, { body: str(body.body), user: viewer, createdAt: '2025-01-01T00:00:00Z' });
        return { status: 201, body: commentView(comment) };
      }
      return { status: 405, body: { message: 'Method Not Allowed' } };
    }
    const commentId = num(rest[2]);
    const comment = issue.comments.find((entry) => entry.id === commentId);
    if (comment === undefined) return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET') return { status: 200, body: commentView(comment) };
    if (method === 'PATCH') {
      if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      (comment as { body: string }).body = str(body.body, comment.body);
      return { status: 200, body: commentView(comment) };
    }
    if (method === 'DELETE') {
      issue.comments.splice(issue.comments.indexOf(comment), 1);
      return { status: 204, body: null };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  return { status: 404, body: { message: 'Not Found' } };
}

/** The pull request routes. */
function handlePulls(forge: Forge, request: ApiRequest, repo: Repo, rest: string[]): Answer {
  const { method, query } = request;
  const viewer = forge.viewer;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls = pulls.sort((a, b) => a.number - b.number);
      const perPage = Math.max(1, Math.min(100, num(query.get('per_page')) ?? 30));
      const pageNumber = Math.max(1, num(query.get('page')) ?? 1);
      const slice = pulls.slice((pageNumber - 1) * perPage, pageNumber * perPage);
      const link = linkHeader(request, pulls.length, perPage, pageNumber);
      return { status: 200, body: slice.map((pull) => pullView(pull, repo, request.baseUrl)), headers: link === null ? {} : { link } };
    }
    if (method === 'POST') {
      if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const head = str(body.head);
      const base = str(body.base) || repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      if (headSha === undefined) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] } };
      const baseSha = repo.refs.get(`refs/heads/${base}`) ?? headSha;
      const existing = [...repo.pulls.values()].find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
      if (existing !== undefined) return { status: 422, body: { message: 'A pull request already exists for this head and base' } };
      const pull: Pull = {
        id: forge.nextGlobalId(),
        number: repo.nextPullNumber(),
        title: str(body.title, head),
        body: str(body.body),
        state: 'open',
        headRef: head,
        baseRef: base,
        baseSha,
        user: viewer,
        createdAt: '2025-01-01T00:00:00Z',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(pull.number, pull);
      return { status: 201, body: pullView(pull, repo, request.baseUrl) };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  const number = num(rest[0]);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (rest.length === 1) {
    if (pull === undefined) return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET') return { status: 200, body: pullView(pull, repo, request.baseUrl) };
    if (method === 'PATCH') {
      if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') (pull as { title: string }).title = body.title;
      if (typeof body.body === 'string') (pull as { body: string }).body = body.body;
      if (body.state === 'closed') pull.state = 'closed';
      return { status: 200, body: pullView(pull, repo, request.baseUrl) };
    }
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }

  if (pull === undefined) return { status: 404, body: { message: 'Not Found' } };

  if (rest[1] === 'files' && rest.length === 2) {
    if (method !== 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
    return { status: 200, body: pullFiles(pull, repo, request.baseUrl) };
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (method !== 'PUT') return { status: 405, body: { message: 'Method Not Allowed' } };
    if (request.bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
    const merged = mergePullRequest(repo, pull, viewer, '2025-01-01T00:00:00Z');
    if (!merged.ok) return { status: merged.failure.status, body: { message: merged.failure.message } };
    return { status: 200, body: { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  if (rest[1] === 'commits' && rest.length === 2) {
    const head = refTip(repo, pull.headRef, pull.baseSha);
    const commits = repo.commitsFrom(head);
    return { status: 200, body: commits.map((commit) => commitJson(commit, repo, request.baseUrl)) };
  }

  return { status: 404, body: { message: 'Not Found' } };
}

/** The GraphQL endpoint's answer, given a parsed request body. */
export function handleGraphQL(forge: Forge, body: unknown, bodyError: string | null, token: string | null): Answer {
  if (token === null) return { status: 401, body: { message: 'Requires authentication' } };
  if (bodyError !== null) return { status: 400, body: { message: 'Problems parsing JSON' } };
  const operations = Array.isArray(body) ? body : [body];
  const responses = operations.map((operation) => {
    const record = (operation ?? {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {};
    const result = executeGraphQL(forge, query, variables);
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  });
  return { status: 200, body: Array.isArray(body) ? responses : responses[0] };
}

/** The MCP endpoint's answer, given a raw request body string. */
export function handleMcp(forge: Forge, rawBody: string, token: string | null, methodHeader: string | null): Answer {
  if (token === null) return { status: 401, body: { message: 'Requires authentication' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : 'not JSON'}` } } };
  }
  const request = (parsed ?? {}) as Record<string, unknown>;
  const outcome = handleRpc(forge, {
    jsonrpc: '2.0',
    id: (request.id ?? null) as string | number | null,
    method: typeof request.method === 'string' ? request.method : (methodHeader ?? ''),
    params: request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {},
  });
  if (outcome.body === null) return { status: outcome.status, body: null };
  return { status: outcome.status, body: outcome.body, headers: outcome.session ? { 'mcp-session-id': `makefun-${String(token).slice(-8)}` } : {} };
}
