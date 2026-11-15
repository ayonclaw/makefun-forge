// The git object model: hashing, trees, commits, tags, packfiles and pkt-lines.
//
// Everything here is a pure function of its arguments: no clock, no randomness, no environment.
// Object ids are git's own (SHA-1 over `<type> <size>\0` + bytes), so an object that arrives in a
// pushed pack and an object this file builds hash the same way and can be compared by id alone.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: the old/new value of a create or a delete. */
export const ZERO_OID = '0'.repeat(40);

/** git's LARGE_PACKET_MAX: the largest pkt-line, its 4-byte length header included. */
export const PKT_MAX = 65520;

/** The largest payload one pkt-line may carry. */
export const PKT_MAX_PAYLOAD = PKT_MAX - 4;

/** A git object, as this forge stores it: its type and its exact content bytes. */
export interface GitObject {
  readonly type: string;
  readonly data: Buffer;
}

/** The loose-object header a git object id is computed over. */
export function objectHeader(type: string, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` and the object's bytes. */
export function hashObject(type: string, data: Uint8Array): string {
  const h = createHash('sha1');
  h.update(objectHeader(type, data.length));
  h.update(data);
  return h.digest('hex');
}

/** Whether `value` is a lowercase 40-hex object id. */
export function isOid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * Inflate the zlib stream that starts at `offset`. `used` is the exact number of bytes the stream
 * occupies, which is what lets a pack be walked entry by entry without a gap.
 */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; used: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, used: result.engine.bytesWritten };
}

// ---------------------------------------------------------------- trees

/** One tree entry: git's ASCII mode, the name, and the object id. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes, entries sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

/** A parsed commit: the headers this forge acts on. */
export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's bytes, tolerating unknown headers (gpgsig, encoding, ...). */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** The header a commit's identity line carries: `Name <mail> <unix seconds> <+0000>`. */
export interface Identity {
  readonly name: string;
  readonly email: string;
  readonly seconds: number;
  readonly timezone: string;
}

/** An identity line's text. */
export function identityLine(who: Identity): string {
  return `${who.name} <${who.email}> ${who.seconds} ${who.timezone}`;
}

/** Build a commit object's bytes. Every field is a caller's, so a commit is reproducible. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: Identity;
  committer?: Identity;
  extraHeaders?: readonly string[];
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${identityLine(fields.author)}`);
  lines.push(`committer ${identityLine(fields.committer ?? fields.author)}`);
  for (const header of fields.extraHeaders ?? []) lines.push(header);
  lines.push('');
  const body = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8');
}

/** A parsed annotated tag. */
export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** An object lookup: the id to the object, or undefined when this store does not hold it. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

// ---------------------------------------------------------------- packfile read

function readSizeVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] ?? 0;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply git's delta format to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let byte = delta[offset++] ?? 0;
    let value = byte & 0x7f;
    let shift = 7;
    while (byte & 0x80) {
      byte = delta[offset++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return value;
  };
  readVarint();
  const targetSize = readVarint();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const cmd = delta[offset++] ?? 0;
    if (cmd & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (cmd & (1 << i)) copyOffset |= (delta[offset++] ?? 0) << (i * 8);
      for (let i = 0; i < 3; i += 1) if (cmd & (1 << (i + 4))) copySize |= (delta[offset++] ?? 0) << (i * 8);
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (cmd !== 0) {
      out.set(delta.subarray(offset, offset + cmd), written);
      written += cmd;
      offset += cmd;
    } else {
      break;
    }
  }
  return out.subarray(0, written);
}

const TYPE_BY_CODE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Whether `bytes` starts with a packfile's magic and a version this forge reads. */
export function looksLikePack(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'PACK';
}

/**
 * Read a packfile and resolve every object in it, OFS_DELTA and REF_DELTA included. `resolveBase`
 * supplies a base a thin pack leaves out (an object the receiving store already holds).
 */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  const objects = new Map<string, GitObject>();
  if (!looksLikePack(pack)) return objects;
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    oid?: string;
    type?: string;
    resolved?: Buffer;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < declared; i += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    offset += inflated.used;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: string; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.type !== undefined && entry.oid !== undefined) {
      return { type: entry.type, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid ?? '';
      const inPack = resolvedByOid.get(wanted);
      if (inPack !== undefined) {
        const base = resolve(inPack);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor held`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = TYPE_BY_CODE[entry.typeCode] ?? 'blob';
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.type = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const done = resolve(entry);
    if (!objects.has(done.oid)) objects.set(done.oid, { type: done.type, data: done.data });
  }
  return objects;
}

// ---------------------------------------------------------------- packfile write

function writeEntryHeader(type: string, size: number): Buffer {
  const code = CODE_BY_TYPE[type] ?? 3;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain (undeltified) objects, trailer checksum included. */
export function writePack(objects: readonly { oid: string; type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writeEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pkt-lines

/** One data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pkt(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet. */
export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet (protocol v2 sections). */
export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Split a pkt-line stream into packets: data payloads plus the control packets. Stops at the first
 * byte that is not a pkt-line header, so a receive-pack body's raw pack is left untouched.
 */
export interface Packet {
  readonly kind: 'data' | 'flush' | 'delim' | 'end';
  readonly payload: Buffer;
}

export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      packets.push({ kind: length === 0 ? 'flush' : length === 1 ? 'delim' : 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: offset };
}

// ---------------------------------------------------------------- reachability

/**
 * Every object reachable from `roots`, walking commits to their parents and trees, tags to their
 * target, and trees to their entries. `stop` may refuse to walk an object's contents (used by a
 * fetch: a commit in the have-set is not re-walked unless the walk is explicitly going through it).
 * `lookup` returns undefined for a missing object, which ends that path.
 */
export function reachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  stop?: (oid: string, object: GitObject) => boolean,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (stop !== undefined && stop(oid, object)) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return seen;
}

/** Whether `ancestor` is `descendant` or one of its ancestors. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}
