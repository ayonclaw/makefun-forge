// The GitHub-shaped read models and the mutations REST, GraphQL and MCP all share.
//
// One store, three surfaces: a repository or an issue created over MCP is the same object REST
// reads, with the same id, so the views here are built once and reused. Every id is derived from
// the store's counters, never from a clock or a random source.

import type { Comment, Issue, Label, Pull, Repo, User } from './store.ts';

/** Base64 of a UTF-8 string, without Node's Buffer padding differences. */
export function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * A Relay global id: opaque, stable across reads, and never the plain numeric id (the suite
 * asserts both). GitHub's own shape is base64 of `<type-code>:<TypeName><number>`.
 */
export function globalId(typeName: string, number: number): string {
  return toBase64(`010:${typeName}${String(number)}`);
}

/** The `number` out of a global id this forge minted, or null when it is not one. */
export function globalIdNumber(value: string): number | null {
  if (typeof value !== 'string' || value === '') return null;
  let decoded = '';
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^010:[A-Za-z]+(\d+)$/.exec(decoded);
  return match === null ? null : Number(match[1]);
}

/** The type name inside a global id, or null. */
export function globalIdType(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const match = /^010:([A-Za-z]+)\d+$/.exec(decoded);
    return match === null ? null : match[1];
  } catch {
    return null;
  }
}

/** A user as GitHub answers it. */
export interface UserView {
  readonly login: string;
  readonly id: number;
  readonly node_id: string;
  readonly type: string;
  readonly site_admin: boolean;
}

/** A repository as GitHub answers it. */
export interface RepoView {
  readonly id: number;
  readonly node_id: string;
  readonly name: string;
  readonly full_name: string;
  readonly private: boolean;
  readonly owner: UserView;
  readonly description: string;
  readonly default_branch: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly has_issues: boolean;
  readonly has_wiki: boolean;
  readonly fork: boolean;
  readonly issues_url: string;
  readonly pulls_url: string;
  readonly contents_url: string;
  readonly url: string;
  readonly html_url: string;
  readonly clone_url: string;
  readonly git_url: string;
  readonly ssh_url: string;
}

/** A label as GitHub answers it. */
export interface LabelView {
  readonly id: number;
  readonly node_id: string;
  readonly name: string;
  readonly color: string;
  readonly default: boolean;
}

/** An issue comment as GitHub answers it. */
export interface CommentView {
  readonly id: number;
  readonly node_id: string;
  readonly body: string;
  readonly user: UserView;
  readonly created_at: string;
  readonly updated_at: string;
}

/** An issue as GitHub answers it. */
export interface IssueView {
  readonly id: number;
  readonly node_id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly labels: LabelView[];
  readonly user: UserView;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly comments: number;
  readonly comments_url: string;
  readonly url: string;
  readonly repository_url: string;
  readonly html_url: string;
  readonly pull_request?: { readonly url: string; readonly html_url: string };
}

/** A git ref as GitHub answers it. */
export interface RefView {
  readonly ref: string;
  readonly node_id: string;
  readonly url: string;
  readonly object: { readonly sha: string; readonly type: string; readonly url: string };
}

/** One branch as GitHub answers it. */
export interface BranchViewJson {
  readonly name: string;
  readonly commit: { readonly sha: string; readonly url: string };
  readonly protected: boolean;
}

/** One commit as GitHub answers it. */
export interface CommitJson {
  readonly sha: string;
  readonly node_id: string;
  readonly url: string;
  readonly commit: {
    readonly message: string;
    readonly author: { readonly name: string; readonly email: string; readonly date: string };
    readonly committer: { readonly name: string; readonly email: string; readonly date: string };
    readonly tree: { readonly sha: string };
  };
  readonly parents: Array<{ readonly sha: string }>;
}

/** One changed file of a pull request. */
export interface PullFileJson {
  readonly sha: string;
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly blob_url: string;
  readonly raw_url: string;
  readonly patch?: string;
}

/** A pull request as GitHub answers it. */
export interface PullView {
  readonly id: number;
  readonly node_id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly user: UserView;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly merged_at: string | null;
  readonly merged: boolean;
  readonly merge_commit_sha: string | null;
  readonly mergeable: boolean | null;
  readonly mergeable_state: string;
  readonly head: { readonly label: string; readonly ref: string; readonly sha: string; readonly user: UserView };
  readonly base: { readonly label: string; readonly ref: string; readonly sha: string; readonly user: UserView };
  readonly url: string;
  readonly html_url: string;
  readonly diff_url: string;
  readonly commits_url: string;
  readonly comments_url: string;
}

/** The epoch every view's timestamp derives from: fixed, so two runs agree (never a clock). */
export const VIEW_EPOCH = '2025-01-01T00:00:00Z';

/** A user's view. */
export function userView(user: User): UserView {
  const index = user.login.length;
  return {
    login: user.login,
    id: 1000 + index,
    node_id: globalId('User', 1000 + index),
    type: 'User',
    site_admin: false,
  };
}

/** A repository's view. */
export function repoView(repo: Repo, baseUrl: string): RepoView {
  const owner = userView({ login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` });
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_wiki: false,
    fork: false,
    issues_url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues{/number}`,
    pulls_url: `${baseUrl}/api/v3/repos/${repo.fullName}/pulls{/number}`,
    contents_url: `${baseUrl}/api/v3/repos/${repo.fullName}/contents/{+path}`,
    url: `${baseUrl}/api/v3/repos/${repo.fullName}`,
    html_url: `${baseUrl}/${repo.fullName}`,
    clone_url: `${baseUrl}/${repo.fullName}.git`,
    git_url: `git://${baseUrl.replace(/^https?:\/\//, '')}/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
  };
}

/** A label's view. */
export function labelView(label: Label, index: number): LabelView {
  return { id: index + 1, node_id: globalId('Label', index + 1), name: label.name, color: label.color, default: false };
}

/** A comment's view. */
export function commentView(comment: Comment): CommentView {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userView(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** An issue's view. */
export function issueView(issue: Issue, repo: Repo, baseUrl: string): IssueView {
  const url = `${baseUrl}/api/v3/repos/${repo.fullName}/issues/${String(issue.number)}`;
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label, index) => labelView(label, index)),
    user: userView(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    comments_url: `${url}/comments`,
    url,
    repository_url: `${baseUrl}/api/v3/repos/${repo.fullName}`,
    html_url: `${baseUrl}/${repo.fullName}/issues/${String(issue.number)}`,
  };
}

/** A ref's view. */
export function refView(ref: string, oid: string, repo: Repo, baseUrl: string): RefView {
  return {
    ref,
    node_id: globalId('Ref', repo.id),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha: oid, type: 'commit', url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${oid}` },
  };
}

/** A branch's view. */
export function branchView(branch: { name: string; sha: string }, repo: Repo, baseUrl: string): BranchViewJson {
  return {
    name: branch.name,
    commit: { sha: branch.sha, url: `${baseUrl}/api/v3/repos/${repo.fullName}/commits/${branch.sha}` },
    protected: false,
  };
}

/** A commit's view. */
export function commitJson(view: { oid: string; tree: string; parents: readonly string[]; message: string; author: string; committer: string }, repo: Repo, baseUrl: string): CommitJson {
  return {
    sha: view.oid,
    node_id: globalId('Commit', repo.id),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/commits/${view.oid}`,
    commit: {
      message: view.message.replace(/\n$/, ''),
      author: identityToJson(view.author),
      committer: identityToJson(view.committer),
      tree: { sha: view.tree },
    },
    parents: view.parents.map((sha) => ({ sha })),
  };
}

function identityToJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: VIEW_EPOCH };
  const seconds = Number(match[3]);
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(seconds * 1000).toISOString() };
}

/** The tip a pull request's head or base ref resolves to right now. */
export function refTip(repo: Repo, refName: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${refName}`) ?? fallback;
}

/** A pull request's view. */
export function pullView(pull: Pull, repo: Repo, baseUrl: string): PullView {
  const headSha = refTip(repo, pull.headRef, pull.baseSha);
  const baseSha = refTip(repo, pull.baseRef, pull.baseSha);
  const conflicted = pull.state === 'open' && repo.conflicts(refTip(repo, pull.baseRef, pull.baseSha), headSha);
  const url = `${baseUrl}/api/v3/repos/${repo.fullName}/pulls/${String(pull.number)}`;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userView(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: pull.mergedAt,
    merged_at: pull.mergedAt,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !conflicted : null,
    mergeable_state: conflicted ? 'dirty' : 'clean',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: userView(pull.user) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: userView(pull.user) },
    url,
    html_url: `${baseUrl}/${repo.fullName}/pull/${String(pull.number)}`,
    diff_url: `${url}.diff`,
    commits_url: `${url}/commits`,
    comments_url: `${url}/comments`,
  };
}

/** The line counts of a blob, for a changed file's additions and deletions. */
function lineCount(oid: string | null, repo: Repo): number {
  if (oid === null) return 0;
  const text = repo.blobText(oid);
  if (text === '') return 0;
  return text.split('\n').filter((line) => line !== '').length;
}

/** A pull request's changed files. */
export function pullFiles(pull: Pull, repo: Repo, baseUrl: string): PullFileJson[] {
  const head = refTip(repo, pull.headRef, pull.baseSha);
  return repo.changedPaths(pull.baseSha, head).map((change) => {
    const additions = lineCount(change.headOid, repo);
    const deletions = lineCount(change.baseOid, repo);
    return {
      sha: change.headOid ?? change.baseOid ?? '',
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `${baseUrl}/api/v3/repos/${repo.fullName}/blob/${pull.headRef}/${change.path}`,
      raw_url: `${baseUrl}/api/v3/repos/${repo.fullName}/raw/${pull.headRef}/${change.path}`,
    };
  });
}

/** Why a merge cannot happen. */
export type MergeFailure = { readonly status: number; readonly message: string };

/**
 * Squash-merge a pull request onto its base branch: one new commit whose tree carries the pull's
 * changes on top of the base tip, the base ref moved to it, and the pull closed and marked merged.
 * The commit is deterministic, so two runs of the same request sequence produce the same sha.
 */
export function mergePullRequest(repo: Repo, pull: Pull, author: User, mergedAt: string): { ok: true; sha: string } | { ok: false; failure: MergeFailure } {
  if (pull.merged) return { ok: false, failure: { status: 405, message: 'Pull Request is not mergeable' } };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return { ok: false, failure: { status: 405, message: 'Pull Request is not mergeable' } };
  const headTip = refTip(repo, pull.headRef, pull.baseSha);
  if (repo.conflicts(baseTip, headTip)) {
    return { ok: false, failure: { status: 405, message: 'Pull Request is not mergeable (conflicts with the base branch)' } };
  }
  const changes = repo.changedPaths(pull.baseSha, headTip);
  const set: Array<{ path: string; content: Buffer }> = [];
  const remove: string[] = [];
  for (const change of changes) {
    if (change.headOid === null) remove.push(change.path);
    else {
      const object = repo.objects.get(change.headOid);
      if (object !== undefined) set.push({ path: change.path, content: object.data });
    }
  }
  const sha = repo.writeCommit({
    parents: [baseTip],
    message: `Merge pull request #${String(pull.number)} from ${pull.headRef}\n\n${pull.title}`,
    author,
    set,
    remove,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = mergedAt;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Create an issue in a repository, in request order. */
export function createIssue(repo: Repo, forge: { nextGlobalId: () => number }, input: { title: string; body: string; labels: readonly Label[]; user: User; createdAt: string }): Issue {
  const issue: Issue = {
    id: forge.nextGlobalId(),
    number: repo.nextIssueNumber(),
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    comments: [],
    user: input.user,
    createdAt: input.createdAt,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a comment on an issue. */
export function createComment(forge: { nextGlobalId: () => number }, issue: Issue, input: { body: string; user: User; createdAt: string }): Comment {
  const comment: Comment = { id: forge.nextGlobalId(), body: input.body, createdAt: input.createdAt, user: input.user };
  issue.comments.push(comment);
  return comment;
}
