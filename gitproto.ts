import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** True for a 40-hex object id. */
export function isOid(value: string): boolean {
  if (value.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = value.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const lower = c >= 97 && c <= 102;
    const upper = c >= 65 && c <= 70;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

/** The SHA-1 id of a loose object: sha1("<type> <size>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Store the object under its id when it is not there yet, and return its id. */
export function storeObject(objects: Map<string, GitObj>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

/** One pkt-line frame around a payload (string or raw bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

const HEX_DIGITS = '0123456789abcdefABCDEF';

function isHex4(text: string): boolean {
  if (text.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    if (HEX_DIGITS.indexOf(text[i] ?? '') < 0) return false;
  }
  return true;
}

/** Decode a whole pkt-line stream into frames. Throws on a bad length prefix. */
export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('pkt-line stream ends mid-length');
    const text = buf.subarray(at, at + 4).toString('ascii');
    if (!isHex4(text)) throw new Error(`bad pkt-line length ${JSON.stringify(text)}`);
    const len = parseInt(text, 16);
    if (len === 0) { out.push({ kind: 'flush' }); at += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); at += 4; continue; }
    if (len === 2) { out.push({ kind: 'end' }); at += 4; continue; }
    if (len < 4 || at + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return out;
}

/** Encode lines into one buffer; the strings 'flush' / 'delim' become markers. */
export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush);
    else if (line === 'delim') parts.push(pktDelim);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/**
 * Frame a payload as sideband data (band 1 by default). A pkt-line holds at
 * most 65520 bytes total: 4 for the length plus 1 for the band byte, so a
 * data chunk is at most 65515 bytes.
 */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const CHUNK = 65515;
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += CHUNK) {
    const slice = data.subarray(at, Math.min(data.length, at + CHUNK));
    const framed = Buffer.concat([Buffer.from([band]), slice]);
    parts.push(pktLine(framed));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree order: a directory name compares with a trailing slash. */
export function treeOrder(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Serialize tree entries in git order. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeOrder);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/**
 * Parse a commit object. Header lines are scanned without splitting the
 * whole body, so a long message costs no extra work.
 */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  let at = 0;
  while (at <= head.length) {
    const nl = head.indexOf('\n', at);
    const line = nl < 0 ? head.slice(at) : head.slice(at, nl);
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
    if (nl < 0) break;
    at = nl + 1;
  }
  return view;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  let at = 0;
  while (at <= head.length) {
    const nl = head.indexOf('\n', at);
    const line = nl < 0 ? head.slice(at) : head.slice(at, nl);
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
    if (nl < 0) break;
    at = nl + 1;
  }
  return view;
}

/** Build a commit object's bytes from its fields. */
export function buildCommitBytes(fields: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let first = (TYPE_CODE[type] << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of whole objects (never deltas) with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    // Level 9 costs a little more CPU at build time, but a pack is built
    // once and then served from the fetch cache, while every clone pays
    // the transfer and inflate cost of its bytes.
    parts.push(deflateSync(object.data, { level: 9 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buffer: Buffer, start: number): { size: number; next: number } {
  let byte = buffer[start] ?? 0;
  let size = byte & 0x0f;
  let shift = 4;
  let at = start + 1;
  while (byte & 0x80) {
    if (at >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[at++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: at };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let at = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (at >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[at++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: at };
}

/** Inflate one zlib stream starting at `offset`; answers the bytes and the next offset. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const used = result.engine.bytesWritten;
  if (!used || used <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + used };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size does not match');
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (at >= delta.length) throw new Error('delta copy is truncated');
          offset |= delta[at++] << (8 * i);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (at >= delta.length) throw new Error('delta copy is truncated');
          size |= delta[at++] << (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      if (at + op > delta.length) throw new Error('delta insert is truncated');
      out.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size does not match');
  return Buffer.concat(out);
}

interface PackEntry {
  offset: number;
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a whole packfile into objects keyed by id, resolving any deltas. */
export function readPack(pack: Buffer): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const expect = createHash('sha1').update(pack.subarray(0, trailerAt)).digest('hex');
  if (pack.subarray(trailerAt).toString('hex') !== expect) throw new Error('pack trailer checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    const first = pack[at] ?? 0;
    const code = (first >> 4) & 0x07;
    const sizeInfo = readVarint(pack, at);
    at = sizeInfo.next;
    if (code === 6) {
      const base = readOfsBase(pack, at);
      const inflated = inflateAt(pack, base.next);
      const entry: PackEntry = { offset: start, type: 'ofs-delta', data: inflated.data, baseOffset: start - base.baseOffset };
      entries.push(entry);
      byOffset.set(start, entry);
      at = inflated.next;
    } else if (code === 7) {
      if (at + 20 > pack.length) throw new Error('ref-delta base oid is truncated');
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      const inflated = inflateAt(pack, at + 20);
      const entry: PackEntry = { offset: start, type: 'ref-delta', data: inflated.data, baseOid };
      entries.push(entry);
      byOffset.set(start, entry);
      at = inflated.next;
    } else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`unknown pack object type ${code}`);
      const inflated = inflateAt(pack, at);
      if (inflated.data.length !== sizeInfo.size) throw new Error('pack object size does not match its header');
      const entry: PackEntry = { offset: start, type, data: inflated.data };
      entries.push(entry);
      byOffset.set(start, entry);
      at = inflated.next;
    }
  }
  const resolved = new Map<string, GitObj>();
  const byOid = new Map<string, GitObj>();
  const resolveEntry = (entry: PackEntry, seen: Set<number>): GitObj => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') return { type: entry.type, data: entry.data };
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let base: GitObj | undefined;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('ofs-delta base is outside the pack');
      base = resolveEntry(baseEntry, seen);
    } else {
      base = byOid.get(entry.baseOid ?? '');
      if (base === undefined) throw new Error('ref-delta base is outside the pack');
    }
    const data = applyDelta(base.data, entry.data);
    return { type: base.type, data };
  };
  for (const entry of entries) {
    const obj = resolveEntry(entry, new Set());
    const oid = hashObject(obj.type, obj.data);
    if (!resolved.has(oid)) resolved.set(oid, obj);
    byOid.set(oid, obj);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export interface ReachOptions {
  /** Stop descending past these commits (their own objects are still included). */
  stopAt?: ReadonlySet<string>;
  /** Only this many commit generations from the roots (1 = the roots themselves). */
  depth?: number;
}

/**
 * Every object reachable from `roots` in `objects`: commits, their trees and
 * blobs, tag targets, and parents. Missing roots are skipped, never thrown.
 */
export function reachableObjects(
  objects: ReadonlyMap<string, GitObj>,
  roots: Iterable<string>,
  options: ReachOptions = {},
): Set<string> {
  const found = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const root of roots) queue.push({ oid: root, generation: 1 });
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    if (found.has(current.oid)) continue;
    const obj = objects.get(current.oid);
    if (obj === undefined) continue;
    found.add(current.oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      if (view.tree !== '') queue.push({ oid: view.tree, generation: current.generation });
      // A depth limit or a shallow boundary cuts the parents off, never the
      // commit's own tree: the boundary commit's files still travel with it.
      if (options.depth !== undefined && current.generation >= options.depth) continue;
      if (options.stopAt !== undefined && options.stopAt.has(current.oid)) continue;
      for (const parent of view.parents) queue.push({ oid: parent, generation: current.generation + 1 });
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push({ oid: entry.oid, generation: current.generation });
    } else if (obj.type === 'tag') {
      const view = parseTag(obj.data);
      if (view.object !== '') queue.push({ oid: view.object, generation: current.generation });
    }
  }
  return found;
}

/** True when `ancestor` is reachable from `tip` (or equals it). */
export function isAncestor(objects: ReadonlyMap<string, GitObj>, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The first commit reachable from both `a` and `b` (nearest to `a`), or null. */
export function mergeBase(objects: ReadonlyMap<string, GitObj>, a: string, b: string): string | null {
  const fromB = new Set<string>();
  const stackB = [b];
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (fromB.has(oid)) continue;
    fromB.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
  }
  const stackA = [a];
  const seenA = new Set<string>();
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (fromB.has(oid)) return oid;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
  }
  return null;
}
