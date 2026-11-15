// The forge's store: repositories, refs, git objects, issues, labels, comments and pull requests.
//
// Everything is in memory and per process, and every id is handed out in request order from a
// counter, so two runs that receive the same requests hold the same store: nothing here reads a
// clock, the environment or a random source. The one exception is deliberate and bounded: the
// request-id header the HTTP layer adds, which is never part of any state the suite exports.

import {
  buildCommit,
  buildTree,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  reachable,
  type GitObject,
  type ObjectLookup,
  type TreeEntry,
} from './objects.ts';
import { scenarioUsers, viewerLogin } from './scenario.ts';

/** A user the store can attribute work to. */
export interface User {
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

const USERS = scenarioUsers();

/** The user the bearer token acts as (the scenario viewer). */
export function tokenUser(): User {
  const viewer = USERS[0] ?? { login: viewerLogin(), name: 'viewer', email: `${viewerLogin()}@example.invalid` };
  return { login: viewer.login, name: viewer.name, email: viewer.email };
}

/** A label on a repository. */
export interface Label {
  readonly name: string;
  readonly color: string;
}

/** An issue comment. */
export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly user: User;
}

/** An issue. */
export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  readonly labels: Label[];
  readonly comments: Comment[];
  readonly user: User;
  readonly createdAt: string;
  closedAt: string | null;
}

/** A pull request, as this forge records it. */
export interface Pull {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  /** The base branch tip this pull was opened against (the diff is taken against it). */
  readonly baseSha: string;
  readonly user: User;
  readonly createdAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

/** A branch, as GET /branches answers it. */
export interface BranchView {
  readonly name: string;
  readonly sha: string;
}

/** A repository and everything in it. */
export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch = 'main';
  readonly createdAt: string;
  /** refName -> object id. */
  readonly refs = new Map<string, string>();
  /** oid -> object. */
  readonly objects = new Map<string, GitObject>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  private issueSeq = 0;
  private pullSeq = 0;
  private commitSeq = 0;

  readonly lookup: ObjectLookup = (oid) => this.objects.get(oid);

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.private = isPrivate;
    this.createdAt = createdAt;
  }

  /** The repository's `owner/name`. */
  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /**
   * Rename the repository. The forge's index is keyed by `owner/name`, so the owner object answers
   * the move through this callback rather than the field being written behind its back.
   */
  rename(next: string): void {
    const previous = this.name;
    (this as { name: string }).name = next;
    this.onRename?.(previous, next);
  }

  /** Set by the forge when it adopts the repository: re-keys the index on a rename. */
  onRename: ((previous: string, next: string) => void) | null = null;

  /** Store one object (idempotent). */
  put(type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** A ref's object id, or undefined when the ref does not exist. */
  ref(name: string): string | undefined {
    return this.refs.get(name);
  }

  /** The default branch's tip. */
  head(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  /** Every ref, sorted by name: a stable order for an advertisement and for ls-refs. */
  refList(): Array<{ name: string; oid: string }> {
    return [...this.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The branches (refs/heads/*), sorted by name. */
  branches(): BranchView[] {
    const out: BranchView[] = [];
    for (const { name, oid } of this.refList()) {
      if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), sha: oid });
    }
    return out;
  }

  /** The commits reachable from `tip`, newest first (a first-parent-ordered walk by commit time). */
  commitsFrom(tip: string | undefined): CommitView[] {
    if (tip === undefined) return [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    const out: CommitView[] = [];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ oid, tree: commit.tree, parents: commit.parents, message: commit.message, author: commit.author, committer: commit.committer });
      for (const parent of commit.parents) queue.push(parent);
    }
    out.sort((a, b) => commitSeconds(b) - commitSeconds(a));
    return out;
  }

  /** The tree entries of a commit's root tree. */
  rootTree(commitOid: string): TreeEntry[] {
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return [];
    const tree = this.objects.get(parseCommit(commit.data).tree);
    return tree === undefined ? [] : parseTree(tree.data);
  }

  /** A tree entry's blob/plain-tree object id at `path` in the given commit, or null. */
  entryAt(commitOid: string, path: string): TreeEntry | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    let entries = this.rootTree(commitOid);
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index] as string;
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry === undefined) return null;
      if (index === segments.length - 1) return entry;
      if (entry.mode !== '40000') return null;
      const child = this.objects.get(entry.oid);
      if (child === undefined) return null;
      entries = parseTree(child.data);
    }
    return null;
  }

  /** Every path in a commit's tree, with its blob oid. */
  paths(commitOid: string | undefined): Map<string, string> {
    const out = new Map<string, string>();
    if (commitOid === undefined) return out;
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (tree === undefined) return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** The paths whose blob differs between two commits. */
  changedPaths(baseOid: string | undefined, headOid: string | undefined): Array<{ path: string; status: string; baseOid: string | null; headOid: string | null }> {
    const base = this.paths(baseOid);
    const head = this.paths(headOid);
    const out: Array<{ path: string; status: string; baseOid: string | null; headOid: string | null }> = [];
    for (const [path, oid] of base) {
      const other = head.get(path);
      if (other === undefined) out.push({ path, status: 'removed', baseOid: oid, headOid: null });
      else if (other !== oid) out.push({ path, status: 'modified', baseOid: oid, headOid: other });
    }
    for (const [path, oid] of head) {
      if (!base.has(path)) out.push({ path, status: 'added', baseOid: null, headOid: oid });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /**
   * A commit's object bytes: deterministic and reproducible, every field a caller's. The tree is
   * either given whole (`tree`) or rebuilt as the first parent's tree with `set` applied and
   * `remove` dropped, which is what a contents write or a merge does.
   */
  writeCommit(options: {
    parents: readonly string[];
    message: string;
    author: User;
    set?: ReadonlyArray<{ path: string; content: Buffer }>;
    remove?: readonly string[];
    tree?: string;
  }): string {
    const parent = options.parents[0];
    const tree = options.tree ?? this.treeWithPath(parent, options.set ?? [], options.remove ?? []);
    this.commitSeq += 1;
    const data = buildCommit({
      tree,
      parents: options.parents,
      message: options.message,
      author: { name: options.author.name, email: options.author.email, seconds: COMMIT_EPOCH + this.commitSeq, timezone: '+0000' },
    });
    return this.put('commit', data);
  }

  /** The tree for `parent`'s tree with `set` written and `remove` dropped, nested by directory. */
  private treeWithPath(
    parent: string | undefined,
    set: ReadonlyArray<{ path: string; content: Buffer }>,
    remove: readonly string[],
  ): string {
    const files = new Map<string, Buffer>();
    for (const [path, oid] of parent === undefined ? [] : this.paths(parent)) {
      const object = this.objects.get(oid);
      if (object !== undefined) files.set(path, object.data);
    }
    for (const path of remove) files.delete(path);
    for (const file of set) files.set(file.path, file.content);
    return this.treeFromPaths(files);
  }

  /** A tree from a path -> content map, one object per directory level. */
  treeFromPaths(files: ReadonlyMap<string, Buffer>): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, content] of files) {
      const segments = path.split('/').filter((segment) => segment !== '');
      if (segments.length === 0) continue;
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index] as string;
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, content);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: this.put('blob', data) });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /** A blob's text, decoded as UTF-8. */
  blobText(oid: string): string {
    return this.objects.get(oid)?.data.toString('utf8') ?? '';
  }

  /** The next issue number. */
  nextIssueNumber(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  /** The next pull request number. */
  nextPullNumber(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }

  /** Whether committing `head` onto `base` would conflict. */
  conflicts(base: string | undefined, head: string | undefined): boolean {
    if (base === undefined || head === undefined) return false;
    const changed = this.changedPaths(base, head);
    if (changed.length === 0) return true;
    // A conflict needs both sides to have touched the same path since they diverged.
    const mergeBase = this.mergeBase(base, head);
    if (mergeBase === undefined) return false;
    const baseSide = new Set(this.changedPaths(mergeBase, base).map((entry) => entry.path));
    for (const entry of this.changedPaths(mergeBase, head)) {
      if (baseSide.has(entry.path) && base !== head) return true;
    }
    return false;
  }

  /** The nearest common ancestor of two commits, by breadth from each. */
  mergeBase(left: string, right: string): string | undefined {
    const leftAncestors = new Set<string>();
    const queue = [left];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (leftAncestors.has(oid)) continue;
      leftAncestors.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const seen = new Set<string>();
    const rightQueue = [right];
    while (rightQueue.length > 0) {
      const oid = rightQueue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (leftAncestors.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) rightQueue.push(parent);
    }
    return undefined;
  }
}

/** A commit as the REST commits route answers it. */
export interface CommitView {
  readonly oid: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
}

/** The fixed epoch every forge-made commit derives its timestamp from (never a clock). */
export const COMMIT_EPOCH = 1_700_000_000;

function commitSeconds(view: CommitView): number {
  const match = / (\d+) [+-]\d{4}$/.exec(view.committer);
  return match === null ? 0 : Number(match[1]);
}

/** The forge: every repository it serves, plus the counters that make ids deterministic. */
export class Forge {
  private readonly repos = new Map<string, Repo>();
  private readonly order: Repo[] = [];
  private repoSeq = 0;
  private globalIdSeq = 0;
  private requestSeq = 0;

  /** The user the token acts as. */
  readonly viewer: User = tokenUser();

  /** Every repository this forge serves, in creation order. */
  allRepos(): Repo[] {
    return [...this.order];
  }

  /** A repository by its numeric id. */
  repoById(id: number): Repo | undefined {
    return this.order.find((repo) => repo.id === id);
  }

  /** A repository by `owner/name`. */
  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  /** Every repository the given owner holds, in creation order. */
  reposOf(owner: string): Repo[] {
    return this.order.filter((repo) => repo.owner === owner);
  }

  /** Create a repository; undefined when the owner already holds that name. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean, createdAt: string): Repo | undefined {
    if (this.repos.has(`${owner}/${name}`)) return undefined;
    this.repoSeq += 1;
    const repo = new Repo(this.repoSeq, owner, name, description, isPrivate, createdAt);
    repo.onRename = (previous, next) => {
      this.repos.delete(`${owner}/${previous}`);
      this.repos.set(`${owner}/${next}`, repo);
    };
    this.repos.set(`${owner}/${name}`, repo);
    this.order.push(repo);
    return repo;
  }

  /** Delete a repository, answering whether it existed. */
  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    if (!this.repos.has(key)) return false;
    this.repos.delete(key);
    const index = this.order.findIndex((repo) => repo.owner === owner && repo.name === name);
    if (index >= 0) this.order.splice(index, 1);
    return true;
  }

  /** The next repository-wide numeric id (issues, pulls, comments). */
  nextGlobalId(): number {
    this.globalIdSeq += 1;
    return this.globalIdSeq;
  }

  /** The next request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `MF-${this.requestSeq.toString(16).padStart(12, '0')}`;
  }

  /** Whether `ancestor` is reachable from `descendant` inside `repo`. */
  isAncestor(ancestor: string, descendant: string, repo: Repo): boolean {
    return isAncestor(ancestor, descendant, repo.lookup);
  }

  /** Every object reachable from `oids` inside `repo`. */
  reachableIn(repo: Repo, oids: Iterable<string>): Set<string> {
    return reachable(oids, repo.lookup);
  }
}
