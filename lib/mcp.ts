// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over the Streamable HTTP transport.
//
// Both eras the rules accept are served from the one handler:
//   modern 2026-07-28 — no handshake, every request declares its revision in `_meta`, and
//           `server/discover` answers the identity, the capabilities and `supportedVersions`;
//   legacy 2025-11-25 and earlier — `initialize` and `notifications/initialized`, answered with a
//           `Mcp-Session-Id` header, and an unknown method is a plain JSON-RPC -32601.
//
// The tools act on the same store REST reads: create_repo, create_issue and the rest go through the
// service layer, so the objects and their ids are one set.

import type { Forge, Repo, User } from './store.ts';
import { createIssue, issueView, mergePullRequest, pullView, repoView } from './views.ts';

/** The current revision this server prefers, and the ones it will fall back to. */
export const PREFERRED_REVISION = '2026-07-28';
export const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

/** A JSON-RPC error object. */
export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A JSON-RPC request as the transport delivers it. */
export interface RpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** One tool the endpoint offers. */
interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, { type: string; description: string }>;
  readonly required: string[];
}

/** The tools github-mcp-server documents, plus the reads an agent wants beside them. */
const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository in the forge and return it.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: { owner: { type: 'string', description: 'The owner login.' }, repo: { type: 'string', description: 'The repository name.' } },
    required: ['owner', 'repo'],
  },
  {
    name: 'list_repos',
    description: 'List the repositories the authenticated token can read.',
    properties: { owner: { type: 'string', description: 'Restrict to one owner login.' } },
    required: [],
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'string', description: 'Comma-separated label names.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Read one issue by its number.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'string', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch.' },
      base: { type: 'string', description: 'The base branch.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request onto its base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'string', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'merge, squash or rebase.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_file_contents',
    description: 'Read a file from a repository at a ref.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      path: { type: 'string', description: 'The repository-relative path.' },
      ref: { type: 'string', description: 'A branch name, tag or commit sha.' },
    },
    required: ['owner', 'repo', 'path'],
  },
  {
    name: 'search_issues',
    description: 'Search the issues of a repository by title text.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      query: { type: 'string', description: 'Text to match in a title.' },
    },
    required: ['owner', 'repo', 'query'],
  },
];

/** The `tools/list` answer: one entry per tool, byte-identical on every call. */
export function toolsList(): { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(tool.properties).map(([key, value]) => [key, { type: value.type, description: value.description }])),
        required: [...tool.required],
        additionalProperties: false,
      },
    })),
  };
}

/** What a tool call answers. */
interface ToolOutcome {
  readonly isError?: boolean;
  readonly value: unknown;
}

/** The text a `tools/call` result carries: the JSON of the value, one line. */
function resultContent(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function argBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Run one tool against the forge. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const viewer: User = forge.viewer;
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name') ?? argString(args, 'repo') ?? argString(args, 'full_name')?.split('/').pop();
      if (repoName === undefined || repoName === '') return { isError: true, value: 'create_repo needs a name' };
      const created = forge.createRepo(viewer.login, repoName, argString(args, 'description') ?? 'created over MCP', argBool(args, 'private') ?? false, '2025-01-01T00:00:00Z');
      if (created === undefined) return { isError: true, value: `a repository named ${repoName} already exists` };
      return { value: repoView(created, '') };
    }
    case 'get_repo': {
      const owner = argString(args, 'owner') ?? viewer.login;
      const repoName = argString(args, 'repo') ?? argString(args, 'full_name')?.split('/').pop() ?? '';
      const repo = forge.repo(owner, repoName);
      if (repo === undefined) return { isError: true, value: `repository ${owner}/${repoName} was not found` };
      return { value: repoView(repo, '') };
    }
    case 'list_repos': {
      const owner = argString(args, 'owner') ?? viewer.login;
      return { value: forge.reposOf(owner).map((repo) => repoView(repo, '')) };
    }
    case 'create_issue': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'create_issue needs an existing repository' };
      const title = argString(args, 'title');
      if (title === undefined || title === '') return { isError: true, value: 'create_issue needs a title' };
      const issue = createIssue(repo, forge, { title, body: argString(args, 'body') ?? '', labels: [], user: viewer, createdAt: '2025-01-01T00:00:00Z' });
      return { value: issueView(issue, repo, '') };
    }
    case 'list_issues': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'list_issues needs an existing repository' };
      const state = (argString(args, 'state') ?? 'open').toLowerCase();
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return { value: issues.map((issue) => issueView(issue, repo, '')) };
    }
    case 'get_issue': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'get_issue needs an existing repository' };
      const number = Number(argString(args, 'issue_number') ?? argString(args, 'number') ?? '');
      const issue = repo.issues.get(number);
      if (issue === undefined) return { isError: true, value: `issue ${String(number)} was not found` };
      return { value: issueView(issue, repo, '') };
    }
    case 'create_pull_request': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'create_pull_request needs an existing repository' };
      const head = argString(args, 'head') ?? argString(args, 'head_ref') ?? argString(args, 'branch');
      const base = argString(args, 'base') ?? argString(args, 'base_ref') ?? repo.defaultBranch;
      const title = argString(args, 'title');
      if (head === undefined || title === undefined) return { isError: true, value: 'create_pull_request needs a title and a head branch' };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      if (headSha === undefined) return { isError: true, value: `the branch ${head} does not exist` };
      const pull = {
        id: forge.nextGlobalId(),
        number: repo.nextPullNumber(),
        title,
        body: argString(args, 'body') ?? '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        baseSha: repo.refs.get(`refs/heads/${base}`) ?? headSha,
        user: viewer,
        createdAt: '2025-01-01T00:00:00Z',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(pull.number, pull);
      return { value: pullView(pull, repo, '') };
    }
    case 'merge_pull_request': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'merge_pull_request needs an existing repository' };
      const number = Number(argString(args, 'pull_number') ?? argString(args, 'number') ?? '');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { isError: true, value: `pull request ${String(number)} was not found` };
      const merged = mergePullRequest(repo, pull, viewer, '2025-01-01T00:00:00Z');
      if (!merged.ok) return { isError: true, value: merged.failure.message };
      return { value: { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    case 'list_pull_requests': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'list_pull_requests needs an existing repository' };
      const state = (argString(args, 'state') ?? 'open').toLowerCase();
      const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
      return { value: pulls.map((pull) => pullView(pull, repo, '')) };
    }
    case 'get_file_contents': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'get_file_contents needs an existing repository' };
      const path = argString(args, 'path') ?? '';
      const ref = argString(args, 'ref') ?? repo.defaultBranch;
      const commit = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? ref;
      const entry = repo.entryAt(commit, path);
      if (entry === null) return { isError: true, value: `${path} was not found at ${ref}` };
      const blob = repo.objects.get(entry.oid);
      return { value: { path, sha: entry.oid, content: blob === undefined ? '' : blob.data.toString('utf8') } };
    }
    case 'search_issues': {
      const repo = lookup(forge, args);
      if (repo === undefined) return { isError: true, value: 'search_issues needs an existing repository' };
      const query = (argString(args, 'query') ?? '').toLowerCase();
      const issues = [...repo.issues.values()].filter((issue) => issue.title.toLowerCase().includes(query));
      return { value: issues.map((issue) => issueView(issue, repo, '')) };
    }
    default:
      return { isError: true, value: `unknown tool ${name}` };
  }
}

function lookup(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  const full = argString(args, 'full_name');
  if (full !== undefined && full.includes('/')) {
    const [owner, name] = full.split('/', 2);
    if (owner !== undefined && name !== undefined) {
      const found = forge.repo(owner, name);
      if (found !== undefined) return found;
    }
  }
  const owner = argString(args, 'owner') ?? argString(args, 'owner_login') ?? forge.viewer.login;
  const name = argString(args, 'repo') ?? argString(args, 'repository') ?? '';
  return forge.repo(owner, name) ?? forge.repo(forge.viewer.login, name);
}

/** A JSON-RPC error for an unknown tool. */
export function unknownTool(name: string): RpcError {
  return { code: -32602, message: `Unknown tool: ${name}` };
}

/** The JSON-RPC method-not-found error. */
export function methodNotFound(method: string): RpcError {
  return { code: -32601, message: `Method not found: ${method}` };
}

/** The `server/discover` result (2026-07-28). */
export function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_REVISIONS],
    capabilities: { tools: { listChanged: false }, logging: {}, prompts: {}, resources: {} },
    instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over REST v3, GraphQL v4 and MCP.',
    serverInfo: { name: 'makefun-forge', version: '1.0.0' },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'makefun-forge', version: '1.0.0' } },
  };
}

/** The `initialize` result (the handshake eras). */
export function initializeResult(revision: string): Record<string, unknown> {
  return {
    protocolVersion: SUPPORTED_REVISIONS.includes(revision) ? revision : PREFERRED_REVISION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'makefun-forge', version: '1.0.0' },
  };
}

/** One JSON-RPC request's answer: a result, or an error. `null` for a notification. */
export function handleRpc(forge: Forge, request: RpcRequest): { status: number; body: Record<string, unknown> | null; session: boolean } {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id ?? null;
  const reply = (payload: Record<string, unknown>): { status: number; body: Record<string, unknown>; session: boolean } => ({ status: 200, body: { jsonrpc: '2.0', id, ...payload }, session: false });
  const error = (err: RpcError, session = false): { status: number; body: Record<string, unknown>; session: boolean } => ({ status: 200, body: { jsonrpc: '2.0', id, error: err }, session });
  switch (method) {
    case 'server/discover':
      return reply({ result: discoverResult() });
    case 'initialize': {
      const requested = typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : PREFERRED_REVISION;
      const answer = reply({ result: initializeResult(requested) });
      return { ...answer, session: true };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, body: null, session: false };
    case 'ping':
      return reply({ result: {} });
    case 'tools/list':
      return reply({ result: toolsList() });
    case 'tools/call': {
      const name = typeof request.params?.name === 'string' ? request.params.name : '';
      const rawArgs = request.params?.arguments;
      const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
      const known = TOOLS.find((tool) => tool.name === name || tool.name.endsWith(name) || name.endsWith(tool.name));
      if (known === undefined) return error(unknownTool(name));
      const missing = known.required.filter((key) => args[key] === undefined);
      if (missing.length > 0) return reply({ result: toolError(`missing required argument(s): ${missing.join(', ')}`) });
      const outcome = callTool(forge, known.name, args);
      if (outcome.isError === true) return reply({ result: toolError(String(outcome.value)) });
      return reply({ result: resultContent(outcome.value) });
    }
    default:
      return error(methodNotFound(method));
  }
}
