// Git smart HTTP: info/refs, upload-pack (protocol v2 and the v0 fallback) and receive-pack.
//
// Nothing here shells out and nothing buffers whole histories: a fetch walks the request's wants
// against the refs, sends only what the client's have-set does not reach, and frames the pack in
// side-band-64k packets of at most PKT_MAX bytes each.
//
// Protocol shape, as the suite drives it:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   the advertisement
//        — with `Git-Protocol: version=2` the v2 capability list ("version 2" first), else v0
//   POST /{owner}/{repo}.git/git-upload-pack                     ls-refs and fetch
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack   the v0 push advertisement
//   POST /{owner}/{repo}.git/git-receive-pack                    the push command list

import { createHash } from 'node:crypto';
import {
  PKT_MAX,
  PKT_MAX_PAYLOAD,
  ZERO_OID,
  delimPkt,
  flushPkt,
  isAncestor,
  isOid,
  parseCommit,
  parsePackets,
  parseTag,
  parseTree,
  pkt,
  readPack,
  reachable,
  writePack,
  type GitObject,
} from './objects.ts';
import type { Repo } from './store.ts';

/** The two services and the media types they use. */
export const UPLOAD_PACK = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_PACK = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
export const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The capabilities the v0 upload-pack advertisement offers. */
const UPLOAD_CAPS = [
  'multi_ack_detailed',
  'multi_ack',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'deepen-relative',
  'no-progress',
  'include-tag',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
  'no-done',
  'symref=HEAD:refs/heads/main',
  'object-format=sha1',
  'agent=makefun-forge/1.0',
];

/** The capabilities the v0 receive-pack advertisement offers (the suite requires three of them). */
const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'object-format=sha1', 'agent=makefun-forge/1.0'];

/** The capabilities the v2 advertisement announces. */
const V2_CAPS = ['version 2', 'agent=makefun-forge/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done filter', 'server-option', 'object-format=sha1'];

/** A v0 advertisement: the service preamble, then the refs with the capabilities on the first line. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), flushPkt()];
  const refs = repo.refList();
  const head = repo.head();
  if (refs.length === 0) {
    // An unborn branch: git advertises a zero-oid HEAD (or the capabilities^{} pseudo-ref).
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps.join(' ')}\n`));
  } else {
    let first = true;
    if (head !== undefined) {
      parts.push(pkt(first ? `${head} HEAD\u0000${caps.join(' ')}\n` : `${head} HEAD\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(pkt(first ? `${ref.oid} ${ref.name}\u0000${caps.join(' ')}\n` : `${ref.oid} ${ref.name}\n`));
      first = false;
      const peeled = peel(repo, ref.name, ref.oid);
      if (peeled !== null) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
    }
    if (first) parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps.join(' ')}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** The commit an annotated tag points at, or null when the ref is not an annotated tag. */
function peel(repo: Repo, refName: string, oid: string): string | null {
  if (!refName.startsWith('refs/tags/')) return null;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

/** The v2 capability advertisement ("version 2" then the capability lines). */
export function v2Advertisement(): Buffer {
  const parts = V2_CAPS.map((line) => pkt(`${line}\n`));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** One v2 ls-refs answer for the prefixes the client asked for. */
export function lsRefs(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const head = repo.head();
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && keep('HEAD')) {
    if (head === undefined) {
      if (args.unborn) parts.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else {
      parts.push(pkt(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const ref of repo.refList()) {
    if (!keep(ref.name)) continue;
    const peeled = args.peel ? peel(repo, ref.name, ref.oid) : null;
    parts.push(pkt(`${ref.oid} ${ref.name}${peeled === null ? '' : ` peeled:${peeled}`}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** Everything a fetch request asked for, read out of its pkt-lines. */
interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
  done: boolean;
  thinPack: boolean;
  noProgress: boolean;
}

function readFetchArgs(packets: readonly { kind: string; payload: Buffer }[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], depth: null, shallow: [], done: false, thinPack: true, noProgress: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
    else if (line === 'done') args.done = true;
    else if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress') args.noProgress = true;
  }
  return args;
}

/** The shallow boundary of a depth-limited walk from `tip`. */
function shallowBoundary(repo: Repo, tips: readonly string[], depth: number): { keep: Set<string>; shallow: string[] } {
  const keep = new Set<string>();
  const frontier: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 0 }));
  const shallow: string[] = [];
  const seen = new Set<string>();
  while (frontier.length > 0) {
    const entry = frontier.shift() as { oid: string; depth: number };
    if (seen.has(entry.oid)) continue;
    seen.add(entry.oid);
    const object = repo.objects.get(entry.oid);
    if (object === undefined) continue;
    keep.add(entry.oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      keep.add(commit.tree);
      for (const item of treeObjects(repo, commit.tree)) keep.add(item);
      if (entry.depth + 1 >= depth) {
        if (commit.parents.length > 0) shallow.push(entry.oid);
        continue;
      }
      for (const parent of commit.parents) frontier.push({ oid: parent, depth: entry.depth + 1 });
    }
  }
  return { keep, shallow };
}

/** A commit's parents, or an empty list for anything that is not a commit. */
function parentsOf(repo: Repo, oid: string): string[] {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** Every object under a tree, the tree itself included. */
function treeObjects(repo: Repo, treeOid: string): string[] {
  const out: string[] = [];
  const queue = [treeOid];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.push(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
  }
  return out;
}

/** The objects a fetch must send: everything reachable from the wants, less everything the haves reach. */
function objectsForFetch(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const wants = args.wants.filter((oid) => isOid(oid) && repo.objects.has(oid));
  const clientShallow = new Set(args.shallow.filter(isOid));
  const haveReach = new Set<string>();
  for (const have of args.haves) {
    if (!isOid(have) || !repo.objects.has(have)) continue;
    // A shallow client's history stops at its own boundary: an object past a shallow line is not
    // held, which is what makes `deepen 2` deliver the parent it is missing.
    for (const oid of reachable([have], repo.lookup, (oid) => clientShallow.has(oid))) haveReach.add(oid);
  }
  let wantReach: Set<string>;
  let shallow: string[] = [];
  if (args.depth !== null && Number.isFinite(args.depth) && args.depth > 0) {
    const bounded = shallowBoundary(repo, wants, args.depth);
    wantReach = bounded.keep;
    shallow = bounded.shallow;
  } else {
    wantReach = new Set<string>();
    for (const want of wants) {
      for (const oid of reachable([want], repo.lookup, (oid) => clientShallow.has(oid) && !wants.includes(oid))) wantReach.add(oid);
    }
    shallow = [...clientShallow].filter((oid) => repo.objects.has(oid)).sort();
    if (clientShallow.size > 0) {
      // The boundary moved one generation: report the client's shallow commits as unshallowed and
      // the deepest commits now held as the new boundary.
      const moved = new Set<string>();
      for (const oid of clientShallow) {
        for (const parent of parentsOf(repo, oid)) if (repo.objects.has(parent) && !clientShallow.has(parent)) moved.add(parent);
      }
      if (moved.size > 0) shallow = [...moved].sort();
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wantReach) {
    if (haveReach.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const unshallow: string[] = [];
  if (args.depth === null && args.shallow.length > 0) {
    for (const oid of args.shallow) if (isOid(oid) && repo.objects.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

/** Frame `bytes` into side-band-64k band-1 packets. */
function sideband(bytes: Buffer, band = 1): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += PKT_MAX_PAYLOAD - 1) {
    const chunk = bytes.subarray(offset, offset + PKT_MAX_PAYLOAD - 1);
    parts.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (bytes.length === 0) parts.push(pkt(Buffer.from([band])));
  return parts;
}

/** The answer to a v2 fetch: ack lines, shallow-info, then the packfile section in side-band. */
export function v2Fetch(repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  const args = readFetchArgs(packets);
  const { objects, shallow, unshallow } = objectsForFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  const haves = args.haves.filter((oid) => isOid(oid) && repo.objects.has(oid));
  if (haves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    for (const have of haves) parts.push(pkt(`ACK ${have}\n`));
    parts.push(pkt('ready\n'));
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(delimPkt());
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  }
  parts.push(delimPkt());
  parts.push(pkt('packfile\n'));
  const pack = objects.length === 0 ? emptyPack() : writePack(objects.map((object) => ({ oid: '', type: object.type, data: object.data })));
  for (const frame of sideband(pack, 1)) parts.push(frame);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** A pack with no entries (an up-to-date fetch still carries a well-formed pack). */
function emptyPack(): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0, 8);
  return Buffer.concat([header, sha1(header)]);
}

function sha1(bytes: Buffer): Buffer {
  return createHash('sha1').update(bytes).digest();
}

/** The answer to a v0 fetch: NAK/ACK then the side-band-framed pack. */
export function v0Fetch(repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  const args = readFetchArgs(packets);
  const { objects } = objectsForFetch(repo, args);
  const parts: Buffer[] = [pkt('NAK\n')];
  const pack = objects.length === 0 ? emptyPack() : writePack(objects.map((object) => ({ oid: '', type: object.type, data: object.data })));
  for (const frame of sideband(pack, 1)) parts.push(frame);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** One push command from a receive-pack request. */
export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** What a receive-pack request carried. */
export interface PushRequest {
  readonly commands: PushCommand[];
  readonly pack: Buffer | null;
  readonly capabilities: Set<string>;
}

/** Read a receive-pack request body: the command list (first line carries the capabilities) then the pack. */
export function parsePushBody(body: Buffer): PushRequest {
  const { packets, rest } = parsePackets(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap.split('=')[0] as string);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  const tail = rest < body.length ? body.subarray(rest) : Buffer.alloc(0);
  return { commands, pack: tail.length > 0 ? tail : null, capabilities };
}

/** The outcome of applying one push command. */
export interface PushResult {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

/** The report-status text for a push: `unpack` then one line per ref. */
export function reportStatus(unpackOk: boolean, unpackDetail: string, results: readonly PushResult[]): Buffer {
  const parts: Buffer[] = [pkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    parts.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/**
 * Apply a push: unpack the pack, then move each ref that fast-forwards. A ref that would not
 * fast-forward is refused with `non-fast-forward` and does not move; a delete needs no pack.
 */
export function applyPush(repo: Repo, request: PushRequest): { results: PushResult[]; unpackOk: boolean; unpackDetail: string } {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (request.pack !== null && request.pack.length > 0) {
    try {
      const objects = readPack(request.pack, repo.lookup);
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : 'unpack failed'}`;
    }
  }
  const results: PushResult[] = [];
  for (const command of request.commands) {
    if (!isOid(command.oldOid) || !isOid(command.newOid) || !command.ref.startsWith('refs/')) {
      results.push({ ref: command.ref, ok: false, reason: 'funny refname' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'cannot delete a ref that does not exist' });
      } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const update = command.oldOid === ZERO_OID && current !== undefined && current !== command.newOid;
    if (current !== undefined && !isAncestor(current, command.newOid, repo.lookup) && !update) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { results, unpackOk, unpackDetail };
}

/** The body of a push answer: the report-status, side-band-framed when the client asked for it. */
export function pushAnswer(results: readonly PushResult[], unpackOk: boolean, unpackDetail: string, capabilities: ReadonlySet<string>): Buffer {
  const report = reportStatus(unpackOk, unpackDetail, results);
  if (capabilities.has('side-band-64k')) {
    const framed: Buffer[] = [];
    for (const chunk of sideband(report, 1)) framed.push(chunk);
    framed.push(flushPkt());
    return Buffer.concat(framed);
  }
  return report;
}

/** `PKT_MAX` is re-exported so the HTTP layer can assert the framing bound. */
export { PKT_MAX };
