// A small GraphQL v4 server: just enough of the language and the schema for the documents gh and
// github-mcp-server send.
//
// It is a real parser (tokens, selections, arguments, variables, inline enum lists and inline input
// objects) and a resolver tree over the forge's store, not a table of canned answers, so an unknown
// field is reported as an error naming it and a repo lookup for an unknown name is `data.repository
// = null` with no errors — the two behaviours the suite asserts.

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { createComment, createIssue, globalId, globalIdNumber, globalIdType, mergePullRequest, refTip } from './views.ts';

// ---------------------------------------------------------------- the language

/** A parsed field selection. */
interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[];
}

/** A parsed operation. */
interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  selections: Selection[];
}

/** One entry of the response's errors array. */
interface GraphQLErrorEntry {
  message: string;
  path: (string | number)[];
}

/** A GraphQL-level failure: HTTP 200 with an errors entry. */
export class GraphQLError extends Error {
  readonly path: (string | number)[];

  constructor(message: string, path: (string | number)[] = []) {
    super(message);
    this.name = 'GraphQLError';
    this.path = path;
  }
}

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly position: number;
}

/** Whether a token is the given punctuator. */
function isPunct(token: Token, value: string): boolean {
  return token.kind === 'punct' && token.value === value;
}

/** Whether a token is a name. */
function isName(token: Token): boolean {
  return token.kind === 'name';
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isName = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...', position: index });
      index += 3;
      continue;
    }
    if (isNameStart(ch)) {
      let value = '';
      while (index < source.length && isName(source[index] as string)) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: 'name', value, position: index - value.length });
      continue;
    }
    if (ch === '"') {
      if (source.slice(index, index + 3) === '"""') {
        const end = source.indexOf('"""', index + 3);
        const value = end < 0 ? source.slice(index + 3) : source.slice(index + 3, end);
        tokens.push({ kind: 'string', value, position: index });
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const next = source[index + 1] ?? '';
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: 'string', value, position: index });
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let value = ch;
      index += 1;
      let isFloat = false;
      while (index < source.length && /[0-9.eE+-]/.test(source[index] as string)) {
        const current = source[index] as string;
        if (current === '.' || current === 'e' || current === 'E') isFloat = true;
        // `-` only continues a number in an exponent.
        if ((current === '+' || current === '-') && !/[eE]/.test(source[index - 1] as string)) break;
        value += current;
        index += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value, position: index - value.length });
      continue;
    }
    tokens.push({ kind: 'punct', value: ch, position: index });
    index += 1;
  }
  tokens.push({ kind: 'eof', value: '', position: source.length });
  return tokens;
}

class Parser {
  private tokens: Token[] = [];
  private index = 0;

  private readonly variables: Readonly<Record<string, unknown>>;

  constructor(variables: Readonly<Record<string, unknown>>) {
    this.variables = variables;
  }

  static parse(source: string, variables: Readonly<Record<string, unknown>>): Operation {
    const parser = new Parser(variables);
    return parser.operation(source);
  }

  private get current(): Token {
    return this.tokens[this.index] as Token;
  }

  operation(source: string): Operation {
    this.tokens = tokenize(source);
    let type: 'query' | 'mutation' | 'subscription' = 'query';
    if (this.current.kind === 'name' && ['query', 'mutation', 'subscription'].includes(this.current.value)) {
      type = this.current.value as 'query' | 'mutation' | 'subscription';
      this.index += 1;
      if (this.current.kind === 'name') this.index += 1; // the operation name
      if (isPunct(this.current, '(')) this.skipBalanced('(', ')');
    }
    const selections = this.selectionSet();
    return { type, selections };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.current;
      if (token.kind === 'eof') return;
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        this.index += 1;
        if (depth === 0) return;
        continue;
      }
      this.index += 1;
    }
  }

  private selectionSet(): Selection[] {
    if (!isPunct(this.current, '{')) return [];
    this.index += 1;
    const selections: Selection[] = [];
    while (!isPunct(this.current, '}')) {
      if (this.current.kind === 'eof') break;
      const selection = this.selection();
      if (selection !== null) selections.push(selection);
    }
    this.index += 1;
    return selections;
  }

  private selection(): Selection | null {
    if (this.current.kind === 'spread') {
      this.index += 1;
      if (isName(this.current) && this.current.value === 'on') {
        this.index += 1;
        this.index += 1; // the type condition
      } else if (isPunct(this.current, '@')) {
        this.skipDirective();
      } else if (isName(this.current)) {
        // a fragment spread: not used by the documents this forge serves
        this.index += 1;
        return null;
      }
      return { alias: null, name: '__fragment', args: {}, selections: this.selectionSet() };
    }
    if (!isName(this.current)) {
      this.index += 1;
      return null;
    }
    const first = this.current.value;
    this.index += 1;
    let alias: string | null = null;
    let name = first;
    if (isPunct(this.current, ':')) {
      this.index += 1;
      alias = first;
      name = this.current.kind === 'name' ? this.current.value : '';
      if (this.current.kind === 'name') this.index += 1;
    }
    const args = this.current.kind === 'punct' && this.current.value === '(' ? this.arguments() : {};
    while (isPunct(this.current, '@')) this.skipDirective();
    return { alias, name, args, selections: this.selectionSet() };
  }

  private skipDirective(): void {
    if (isPunct(this.current, '@')) {
      this.index += 1;
      if (this.current.kind === 'name') this.index += 1;
      if (isPunct(this.current, '(')) this.skipBalanced('(', ')');
    }
  }

  private arguments(): Record<string, unknown> {
    this.index += 1; // (
    const args: Record<string, unknown> = {};
    while (!isPunct(this.current, ')')) {
      if (this.current.kind === 'eof') break;
      if (!isName(this.current)) {
        this.index += 1;
        continue;
      }
      const name = this.current.value;
      this.index += 1;
      if (isPunct(this.current, ':')) {
        this.index += 1;
        args[name] = this.value();
      }
    }
    this.index += 1; // )
    return args;
  }

  private value(): unknown {
    const token = this.current;
    if (isPunct(token, '$')) {
      this.index += 1;
      const name = this.current.kind === 'name' ? this.current.value : '';
      if (this.current.kind === 'name') this.index += 1;
      return this.variables[name];
    }
    if (token.kind === 'string') {
      this.index += 1;
      return token.value;
    }
    if (token.kind === 'int') {
      this.index += 1;
      return Number(token.value);
    }
    if (token.kind === 'float') {
      this.index += 1;
      return Number(token.value);
    }
    if (token.kind === 'name') {
      this.index += 1;
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (isPunct(token, '[')) {
      this.index += 1;
      const list: unknown[] = [];
      while (!isPunct(this.current, ']')) {
        if (this.current.kind === 'eof') break;
        list.push(this.value());
      }
      this.index += 1;
      return list;
    }
    if (isPunct(token, '{')) {
      this.index += 1;
      const object: Record<string, unknown> = {};
      while (!isPunct(this.current, '}')) {
        if (this.current.kind === 'eof') break;
        if (!isName(this.current)) {
          this.index += 1;
          continue;
        }
        const name = this.current.value;
        this.index += 1;
        if (isPunct(this.current, ':')) {
          this.index += 1;
          object[name] = this.value();
        }
      }
      this.index += 1;
      return object;
    }
    this.index += 1;
    return null;
  }
}

/** An enum value unwrapped to an array of names (`states: [OPEN]` and `states: OPEN` both work). */
function enumNames(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => enumNames(item));
  if (typeof value === 'object' && '__enum' in (value as Record<string, unknown>)) return [(value as { __enum: string }).__enum];
  if (typeof value === 'string') return [value];
  return [];
}

// ---------------------------------------------------------------- the schema

/** The fields of the types gh feature-detects, which `__type` must describe. */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closed', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'commits', 'additions', 'deletions'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'url', 'labels'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color'],
};

/** The enum values gh probes (SearchType must include ISSUE). */
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The environment one operation resolves against. */
interface Resolver {
  readonly forge: Forge;
  readonly viewer: string;
  readonly errors: GraphQLErrorEntry[];
  repo: Repo | null;
}

/** Execute one operation document and answer its `{data, errors}` envelope. */
export function executeGraphQL(forge: Forge, document: string, variables: Readonly<Record<string, unknown>>): { data: unknown; errors: GraphQLErrorEntry[] } {
  let operation: Operation;
  try {
    operation = Parser.parse(document, variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err), path: [] }] };
  }
  const context: Resolver = { forge, viewer: forge.viewer.login, errors: [], repo: null };
  let data: Record<string, unknown> = {};
  try {
    data = resolveSelections(operation, context);
  } catch (err) {
    context.errors.push({ message: err instanceof Error ? err.message : String(err), path: [] });
  }
  return { data, errors: context.errors };
}

function resolveSelections(operation: Operation, context: Resolver): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    const key = selection.alias ?? selection.name;
    try {
      out[key] = resolveRootField(operation.type, selection, context, [key]);
    } catch (err) {
      if (err instanceof GraphQLError) {
        context.errors.push({ message: err.message, path: err.path.length > 0 ? err.path : [key] });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function unwrap(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '__enum' in (value as Record<string, unknown>)) return (value as { __enum: string }).__enum;
  return value;
}

function str(value: unknown): string {
  const unwrapped = unwrap(value);
  return typeof unwrapped === 'string' ? unwrapped : String(unwrapped ?? '');
}

function num(value: unknown, fallback = 0): number {
  const unwrapped = unwrap(value);
  return typeof unwrapped === 'number' && Number.isFinite(unwrapped) ? unwrapped : fallback;
}

function resolveRootField(kind: Operation['type'], selection: Selection, context: Resolver, path: (string | number)[]): unknown {
  if (selection.name === '__typename') return kind === 'mutation' ? 'Mutation' : 'Query';
  if (selection.name === '__type') return resolveType(selection, context, path);
  if (selection.name === '__schema') return { types: Object.keys(TYPE_FIELDS).map((name) => ({ name })) };
  if (kind === 'mutation') return resolveMutation(selection, context, path);
  switch (selection.name) {
    case 'viewer':
      return viewerNode(selection, context, path);
    case 'repository': {
      const owner = str(selection.args.owner);
      const name = str(selection.args.name);
      const repo = context.forge.repo(owner, name);
      context.repo = repo ?? null;
      return repo === undefined ? null : repoNode(repo, selection, context, path);
    }
    case 'node': {
      const id = str(selection.args.id);
      return resolveNode(id, selection, context, path);
    }
    case 'rateLimit':
      return { limit: 5000, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' };
    default:
      throw new GraphQLError(`Cannot query field "${selection.name}" on type "Query".`, path);
  }
}

/** The viewer (the token's own user), honouring the requested fields — an unknown field is an error. */
function viewerNode(selection: Selection, context: Resolver, path: (string | number)[]): Record<string, unknown> {
  const login = context.viewer;
  const known: Record<string, unknown> = {
    login,
    id: globalId('User', 1000),
    name: login,
    email: `${login}@example.invalid`,
    url: `/${login}`,
    __typename: 'User',
  };
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    const key = child.alias ?? child.name;
    if (child.name in known) {
      out[key] = known[child.name];
      continue;
    }
    const err = new GraphQLError(`Cannot query field "${child.name}" on type "User".`, [...path, key]);
    context.errors.push({ message: err.message, path: err.path });
  }
  return out;
}

function resolveType(selection: Selection, context: Resolver, path: (string | number)[]): unknown {  void context;
  void path;
  const name = str(selection.args.name);
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  const out: Record<string, unknown> = { name, kind: enumValues === undefined ? 'OBJECT' : 'ENUM' };
  for (const child of selection.selections) {
    const key = child.alias ?? child.name;
    if (child.name === 'fields') out[key] = fields === undefined ? null : fields.map((field) => ({ name: field }));
    else if (child.name === 'enumValues') out[key] = enumValues === undefined ? null : enumValues.map((value) => ({ name: value }));
    else if (child.name === 'name') out[key] = name;
    else if (child.name === 'kind') out[key] = enumValues === undefined ? 'OBJECT' : 'ENUM';
    else if (child.name === '__typename') out[key] = '__Type';
  }
  return out;
}

function resolveNode(id: string, selection: Selection, context: Resolver, path: (string | number)[]): unknown {
  const type = globalIdType(id);
  const number = globalIdNumber(id);
  if (type === null || number === null) return null;
  // A fragment selection (`... on Repository { name nameWithOwner }`) is resolved exactly like an
  // inline selection set on the node: the fragment's own fields are what the caller asked for.
  const merged: Selection = {
    alias: selection.alias,
    name: selection.name,
    args: selection.args,
    selections: selection.selections.flatMap((child) => (child.name === '__fragment' ? child.selections : [child])),
  };
  if (type === 'Repository') {
    const repo = context.forge.repoById(number);
    if (repo === undefined) return null;
    context.repo = repo;
    return repoNode(repo, merged, context, path);
  }
  if (type === 'Issue') {
    for (const repo of context.forge.allRepos()) {
      for (const issue of repo.issues.values()) {
        if (issue.id !== number) continue;
        return issueNode(repo, issue, merged, context);
      }
    }
  }
  return null;
}

/** A repository node, resolved by the field names the suite selects. */
function repoNode(repo: Repo, selection: Selection, context: Resolver, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const resolveOne = (child: Selection): unknown => {
    const args = child.args;
    switch (child.name) {
      case '__typename':
        return 'Repository';
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'createdAt':
        return repo.createdAt;
      case 'url':
        return `${repo.fullName}`;
      case 'hasIssuesEnabled':
        return true;
      case 'viewerPermission':
        return 'ADMIN';
      case 'owner':
        return { login: repo.owner, id: globalId('User', 1000) };
      case 'defaultBranchRef': {
        const head = repo.head();
        return head === undefined ? null : { name: repo.defaultBranch, target: { oid: head } };
      }
      case 'issue': {
        const number = num(args.number);
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueNode(repo, issue, child, context);
      }
      case 'issues':
        return issuesConnection(repo, child, context, path);
      case 'pullRequests':
        return pullsConnection(repo, child);
      case 'pullRequest': {
        const number = num(args.number);
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullNode(repo, pull, child);
      }
      case 'labels':
        return { nodes: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
      default:
        throw new GraphQLError(`Cannot query field "${child.name}" on type "Repository".`, [...path, child.alias ?? child.name]);
    }
  };
  for (const child of selection.selections) {
    if (child.name === '__fragment') {
      for (const inner of child.selections) {
        const key = inner.alias ?? inner.name;
        try {
          out[key] = resolveOne(inner);
        } catch (err) {
          if (err instanceof GraphQLError) {
            context.errors.push({ message: err.message, path: err.path });
            out[key] = null;
          } else {
            throw err;
          }
        }
      }
      continue;
    }
    const key = child.alias ?? child.name;
    try {
      out[key] = resolveOne(child);
    } catch (err) {
      if (err instanceof GraphQLError) {
        context.errors.push({ message: err.message, path: err.path });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

/** A cursor names the last item's position in the ordered list (an opaque string to the client). */
function cursorIndexOf(cursor: unknown): number | null {
  if (cursor === null || cursor === undefined) return null;
  const text = typeof cursor === 'number' ? String(cursor) : typeof cursor === 'string' ? cursor : '';
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function issuesConnection(repo: Repo, selection: Selection, context: Resolver, path: (string | number)[]): Record<string, unknown> {
  const states = enumNames(selection.args.states);
  const order = (selection.args.orderBy ?? {}) as Record<string, unknown>;
  const direction = unwrap(order.direction) === 'ASC' ? 'ASC' : 'DESC';
  const first = selection.args.first === undefined ? null : num(selection.args.first);
  const after = cursorIndexOf(unwrap(selection.args.after));
  let issues = [...repo.issues.values()].filter((issue) => states.length === 0 || states.includes(issue.state.toUpperCase()));
  issues = issues.slice().sort((a, b) => (a.number - b.number) * (direction === 'ASC' ? 1 : -1));
  const start = after === null ? 0 : after + 1;
  const page = first === null ? issues.slice(start) : issues.slice(start, start + first);
  const hasNextPage = first !== null && start + first < issues.length;
  const pageInfoSelection = selection.selections.find((child) => child.name === 'pageInfo');
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    const key = child.alias ?? child.name;
    if (child.name === 'nodes') {
      out[key] = page.map((issue) => issueNode(repo, issue, child, context));
    } else if (child.name === 'pageInfo') {
      out[key] = pageInfoOf(hasNextPage, start > 0, start + page.length - 1, pageInfoSelection);
    } else if (child.name === 'totalCount') {
      out[key] = issues.length;
    } else if (child.name === '__typename') {
      out[key] = 'IssueConnection';
    }
  }
  void path;
  return out;
}

/** The pageInfo object, honouring the requested sub-selection. Cursors are list positions. */
function pageInfoOf(hasNextPage: boolean, hasPreviousPage: boolean, endIndex: number, selection: Selection | undefined): Record<string, unknown> {
  const cursors = {
    hasNextPage,
    hasPreviousPage,
    endCursor: endIndex < 0 ? null : String(endIndex),
    startCursor: null,
  };
  if (selection === undefined) return cursors;
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) out[child.alias ?? child.name] = (cursors as Record<string, unknown>)[child.name] ?? null;
  return out;
}

function issueNode(repo: Repo, issue: Issue, selection: Selection, context: Resolver): Record<string, unknown> {
  const resolveOne = (child: Selection): unknown => {    switch (child.name) {
      case '__typename':
        return 'Issue';
      case 'id':
        return globalId('Issue', issue.id);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'url':
        return `/${repo.fullName}/issues/${String(issue.number)}`;
      case 'closed':
        return issue.state === 'closed';
      case 'createdAt':
      case 'updatedAt':
        return issue.createdAt;
      case 'author':
        return { login: issue.user.login };
      case 'labels':
        return { nodes: issue.labels.map((label) => ({ name: label.name, color: label.color })) };
      case 'comments':
        return { nodes: issue.comments.map((comment) => ({ id: globalId('IssueComment', comment.id), body: comment.body })), totalCount: issue.comments.length };
      case 'repository':
        return { name: repo.name, nameWithOwner: repo.fullName, id: globalId('Repository', repo.id) };
      default:
        throw new GraphQLError(`Cannot query field "${child.name}" on type "Issue".`, [child.alias ?? child.name]);
    }
  };
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    const key = child.alias ?? child.name;
    try {
      out[key] = resolveOne(child);
    } catch (err) {
      if (err instanceof GraphQLError) {
        context.errors.push({ message: err.message, path: err.path });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function pullsConnection(repo: Repo, selection: Selection): Record<string, unknown> {
  const first = selection.args.first === undefined ? null : num(selection.args.first);
  const pulls = [...repo.pulls.values()].slice().sort((a, b) => a.number - b.number);
  const page = first === null ? pulls : pulls.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    const key = child.alias ?? child.name;
    if (child.name === 'nodes') out[key] = page.map((pull) => pullNode(repo, pull, child));
    else if (child.name === 'totalCount') out[key] = pulls.length;
    else if (child.name === 'pageInfo') out[key] = pageInfoOf(first !== null && pulls.length > first, false, page.length - 1, child);
    else if (child.name === '__typename') out[key] = 'PullRequestConnection';
  }
  return out;
}

function pullNode(repo: Repo, pull: Pull, parent: Selection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const head = refTip(repo, pull.headRef, pull.baseSha);
  const base = refTip(repo, pull.baseRef, pull.baseSha);
  const conflicted = pull.state === 'open' && repo.conflicts(base, head);
  for (const child of parent.selections) {
    const key = child.alias ?? child.name;
    switch (child.name) {
      case '__typename':
        out[key] = 'PullRequest';
        break;
      case 'id':
        out[key] = globalId('PullRequest', pull.id);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pull.merged ? 'MERGED' : pull.state.toUpperCase();
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable':
        out[key] = pull.state === 'open' ? (conflicted ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
        break;
      case 'mergeCommit':
        out[key] = pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha };
        break;
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'headRefOid':
        out[key] = head;
        break;
      case 'baseRefOid':
        out[key] = base;
        break;
      case 'createdAt':
      case 'updatedAt':
        out[key] = pull.createdAt;
        break;
      case 'author':
      case 'headRepositoryOwner':
        out[key] = { login: pull.user.login };
        break;
      case 'files': {
        const changes = repo.changedPaths(pull.baseSha, head);
        const first = child.args.first === undefined ? null : num(child.args.first);
        const page = first === null ? changes : changes.slice(0, first);
        out[key] = { nodes: page.map((change) => ({ path: change.path, additions: 1, deletions: 1, changes: 2 })) };
        break;
      }
      default:
        out[key] = null;
        break;
    }
  }
  if (!('mergeable' in out)) out.mergeable = pull.state === 'open' ? (conflicted ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
  return out;
}

// ---------------------------------------------------------------- mutations

function resolveMutation(selection: Selection, context: Resolver, path: (string | number)[]): unknown {
  const input = (selection.args.input ?? {}) as Record<string, unknown>;
  switch (selection.name) {
    case 'createIssue':
      return createIssueMutation(selection, input, context, path);
    case 'closeIssue':
      return closeIssueMutation(selection, input, context, path);
    case 'reopenIssue':
      return reopenIssueMutation(selection, input, context, path);
    case 'createPullRequest':
      return createPullRequestMutation(selection, input, context, path);
    case 'mergePullRequest':
      return mergePullRequestMutation(selection, input, context, path);
    case 'closePullRequest':
      return closePullRequestMutation(selection, input, context, path);
    case 'addComment':
      return addCommentMutation(selection, input, context, path);
    default:
      throw new GraphQLError(`Cannot query field "${selection.name}" on type "Mutation".`, path);
  }
}

const NOW = '2025-01-01T00:00:00Z';

function findRepoByGlobalId(forge: Forge, id: unknown): Repo | null {
  const number = globalIdNumber(typeof id === 'string' ? id : '');
  if (number === null) return null;
  return forge.repoById(number) ?? null;
}

function findIssueByGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  const number = globalIdNumber(typeof id === 'string' ? id : '');
  if (number === null) return null;
  for (const repo of forge.allRepos()) {
    for (const issue of repo.issues.values()) if (issue.id === number) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  const number = globalIdNumber(typeof id === 'string' ? id : '');
  if (number === null) return null;
  for (const repo of forge.allRepos()) {
    for (const pull of repo.pulls.values()) if (pull.id === number) return { repo, pull };
  }
  return null;
}

function createIssueMutation(selection: Selection, input: Record<string, unknown>, context: Resolver, path: (string | number)[]): unknown {
  const repo = findRepoByGlobalId(context.forge, input.repositoryId);
  if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the global id given.', path);
  const issue = createIssue(repo, context.forge, {
    title: str(input.title),
    body: typeof input.body === 'string' ? input.body : '',
    labels: [],
    user: { login: context.viewer, name: context.viewer, email: `${context.viewer}@example.invalid` },
    createdAt: NOW,
  });
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    if (child.name === 'issue') out[child.alias ?? child.name] = projectIssue(repo, issue, child, context);
    else if (child.name === '__typename') out[child.alias ?? child.name] = 'CreateIssuePayload';
  }
  return out;
}

function closeIssueMutation(selection: Selection, input: Record<string, unknown>, context: Resolver, path: (string | number)[]): unknown {
  const found = findIssueByGlobalId(context.forge, input.issueId);
  if (found === null) throw new GraphQLError('Could not resolve to an Issue with the global id given.', path);
  found.issue.state = 'closed';
  found.issue.closedAt = NOW;
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    if (child.name === 'issue') out[child.alias ?? child.name] = projectIssue(found.repo, found.issue, child, context);
  }
  return out;
}

function reopenIssueMutation(selection: Selection, input: Record<string, unknown>, context: Resolver, path: (string | number)[]): unknown {
  const found = findIssueByGlobalId(context.forge, input.issueId);
  if (found === null) throw new GraphQLError('Could not resolve to an Issue with the global id given.', path);
  found.issue.state = 'open';
  found.issue.closedAt = null;
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    if (child.name === 'issue') out[child.alias ?? child.name] = projectIssue(found.repo, found.issue, child, context);
  }
  return out;
}

/** The fields a mutation asks of an issue. */
function projectIssue(repo: Repo, issue: Issue, selection: Selection, context: Resolver): Record<string, unknown> {
  return issueNode(repo, issue, selection, context);
}

function createPullRequestMutation(selection: Selection, input: Record<string, unknown>, context: Resolver, path: (string | number)[]): unknown {
  const repo = findRepoByGlobalId(context.forge, input.repositoryId);
  if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the global id given.', path);
  const headRef = str(input.headRefName);
  const baseRef = str(input.baseRefName);
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  if (headSha === undefined) throw new GraphQLError(`Could not resolve to a branch named ${JSON.stringify(headRef)}.`, path);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? headSha;
  const pull: Pull = {
    id: context.forge.nextGlobalId(),
    number: repo.nextPullNumber(),
    title: str(input.title),
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef,
    baseRef,
    baseSha,
    user: { login: context.viewer, name: context.viewer, email: `${context.viewer}@example.invalid` },
    createdAt: NOW,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.set(pull.number, pull);
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    if (child.name === 'pullRequest') out[child.alias ?? child.name] = pullNode(repo, pull, child);
  }
  return out;
}

function mergePullRequestMutation(selection: Selection, input: Record<string, unknown>, context: Resolver, path: (string | number)[]): unknown {
  const found = findPullByGlobalId(context.forge, input.pullRequestId);
  if (found === null) throw new GraphQLError('Could not resolve to a PullRequest with the global id given.', path);
  const merged = mergePullRequest(found.repo, found.pull, { login: context.viewer, name: context.viewer, email: `${context.viewer}@example.invalid` }, NOW);
  if (!merged.ok) throw new GraphQLError(`Pull request #${String(found.pull.number)} is not mergeable.`, path);
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    if (child.name === 'pullRequest') out[child.alias ?? child.name] = pullNode(found.repo, found.pull, child);
  }
  return out;
}

function closePullRequestMutation(selection: Selection, input: Record<string, unknown>, context: Resolver, path: (string | number)[]): unknown {
  const found = findPullByGlobalId(context.forge, input.pullRequestId);
  if (found === null) throw new GraphQLError('Could not resolve to a PullRequest with the global id given.', path);
  found.pull.state = 'closed';
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    if (child.name === 'pullRequest') out[child.alias ?? child.name] = pullNode(found.repo, found.pull, child);
  }
  return out;
}

function addCommentMutation(selection: Selection, input: Record<string, unknown>, context: Resolver, path: (string | number)[]): unknown {
  const found = findIssueByGlobalId(context.forge, input.subjectId);
  if (found === null) throw new GraphQLError('Could not resolve to a node with the global id given.', path);
  const comment = createComment(context.forge, found.issue, {
    body: str(input.body),
    user: { login: context.viewer, name: context.viewer, email: `${context.viewer}@example.invalid` },
    createdAt: NOW,
  });
  const out: Record<string, unknown> = {};
  for (const child of selection.selections) {
    if (child.name === 'commentEdge') out[child.alias ?? child.name] = { node: { id: globalId('IssueComment', comment.id), body: comment.body } };
  }
  return out;
}
