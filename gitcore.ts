// Pure git object model, pack codec and pkt-line codec. No I/O, no store access:
// every function works on buffers and plain maps, so REST, smart HTTP and the
// graders can share the same byte-exact object semantics.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflateSync, inflateSync as zlibInflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** SHA-1 of `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Tree entry, before encoding. Sort is git's: byte order of name, a directory as if it ended in '/'. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function treeSortKey(entry: TreeEntry): Buffer {
  const name = entry.name;
  return entry.mode === '40000' ? Buffer.from(`${name}/`, 'utf8') : Buffer.from(name, 'utf8');
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, offset);
    if (space === -1 || nul === -1 || space > nul) break;
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitIdentity {
  name: string;
  email: string;
  epoch: number;
  tz: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: CommitIdentity;
  committer: CommitIdentity;
  message: string;
}

function parseIdentity(line: string): CommitIdentity {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match) {
    return { name: match[1]!, email: match[2]!, epoch: Number(match[3]), tz: match[4]! };
  }
  return { name: line, email: '', epoch: 0, tz: '+0000' };
}

export function formatIdentity(identity: CommitIdentity): string {
  return `${identity.name} <${identity.email}> ${identity.epoch} ${identity.tz}`;
}

/** Parse a commit byte stream (headers up to the blank line, then the message). */
export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const headerText = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  const commit: Commit = {
    tree: '',
    parents: [],
    author: { name: '', email: '', epoch: 0, tz: '+0000' },
    committer: { name: '', email: '', epoch: 0, tz: '+0000' },
    message,
  };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) commit.committer = parseIdentity(line.slice(10));
  }
  return commit;
}

export function buildCommit(commit: Commit): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdentity(commit.author)}`);
  lines.push(`committer ${formatIdentity(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface Tag {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: CommitIdentity;
  message: string;
}

export function parseTag(data: Buffer): Tag {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const headerText = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  const tag: Tag = {
    object: '',
    type: 'commit',
    tag: '',
    tagger: { name: '', email: '', epoch: 0, tz: '+0000' },
    message,
  };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = parseIdentity(line.slice(7));
  }
  return tag;
}

export function buildTag(tag: Tag): Buffer {
  const lines = [
    `object ${tag.object}`,
    `type ${tag.type}`,
    `tag ${tag.tag}`,
    `tagger ${formatIdentity(tag.tagger)}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${tag.message}`, 'utf8');
}

// ---- pkt-line ---------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

export interface PktLine {
  /** 'data' with a payload, or one of the three control markers. */
  kind: 'data' | 'flush' | 'delim' | 'response_end';
  data?: Buffer;
}

/** Decode a whole pkt-line stream into lines. Stops at the end of the buffer. */
export function decodePktLines(buffer: Buffer, offset = 0): { lines: PktLine[]; endOffset: number } {
  const lines: PktLine[] = [];
  let cursor = offset;
  while (cursor + 4 <= buffer.length) {
    const length = Number.parseInt(buffer.toString('ascii', cursor, cursor + 4), 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) {
      lines.push({ kind: 'flush' });
      cursor += 4;
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim' });
      cursor += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'response_end' });
      cursor += 4;
      continue;
    }
    if (cursor + length > buffer.length) break;
    lines.push({ kind: 'data', data: buffer.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { lines, endOffset: cursor };
}

/**
 * A sideband packet: band byte (1 pack data, 2 progress, 3 error) + payload, framed
 * as a pkt-line. The pack data inside band 1 is chunked so no pkt-line exceeds
 * 65520 bytes (payload <= 65515).
 */
export function encodeSideband(band: 1 | 2 | 3, payload: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  if (band === 1) {
    for (let offset = 0; offset < payload.length || payload.length === 0; offset += 65515) {
      const slice = payload.subarray(offset, offset + 65515);
      chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
      if (payload.length === 0) break;
    }
    return chunks;
  }
  const max = 65515;
  for (let offset = 0; offset < payload.length || payload.length === 0; offset += max) {
    const slice = payload.subarray(offset, offset + max);
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([band]), slice])));
    if (payload.length === 0) break;
  }
  return chunks;
}

// ---- delta (pack) -----------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function decodePackObjectHeader(pack: Buffer, offset: number): { typeCode: number; size: number; endOffset: number } {
  const first = pack[offset]!;
  const typeCode = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let cursor = offset + 1;
  let byte = first;
  while (byte & 0x80) {
    byte = pack[cursor]!;
    cursor += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, endOffset: cursor };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let cursor = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[cursor]!;
      cursor += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const resultSize = readVarint();
  void sourceSize;
  const out: Buffer[] = [];
  let produced = 0;
  while (cursor < delta.length) {
    const command = delta[cursor]!;
    cursor += 1;
    if (command & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (command & 0x01) copyOffset = delta[cursor]!;
      if (command & 0x02) copyOffset |= delta[cursor + 1]! << 8;
      if (command & 0x04) copyOffset |= delta[cursor + 2]! << 16;
      if (command & 0x08) copyOffset |= delta[cursor + 3]! << 24;
      if (command & 0x10) copySize = delta[cursor]!;
      if (command & 0x20) copySize |= delta[cursor + 1]! << 8;
      if (command & 0x40) copySize |= delta[cursor + 2]! << 16;
      if (copySize === 0) copySize = 0x10000;
      let read = 0;
      if (command & 0x01) read += 1;
      if (command & 0x02) read += 1;
      if (command & 0x04) read += 1;
      if (command & 0x08) read += 1;
      if (command & 0x10) read += 1;
      if (command & 0x20) read += 1;
      if (command & 0x40) read += 1;
      cursor += read;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (command > 0) {
      out.push(delta.subarray(cursor, cursor + command));
      cursor += command;
      produced += command;
    } else {
      throw new Error('invalid delta: zero opcode');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) {
    throw new Error('invalid delta: size mismatch');
  }
  return result;
}

/**
 * Serialise plain (undeltified) objects into a version 2 packfile. The entries are
 * written in the order given; a caller's sort is irrelevant for correctness.
 */
/**
 * Cache of deflated object payloads, keyed by oid (the oid fixes type + data,
 * and stored objects are never mutated in place, so a cached entry stays
 * correct for the life of the process). Packs are rebuilt constantly — the
 * same objects are packed on every fetch of a repo — while the deflate is
 * the most expensive step of writePack, so this is the single biggest
 * server-CPU saving in the git transport path. FIFO eviction, bounded.
 */
interface CachedDeflated {
  header: Buffer;
  deflated: Buffer;
}
const deflateCache = new Map<string, CachedDeflated>();
const DEFLATE_CACHE_MAX = 1024;

function deflatedObject(oid: string, type: GitObjectType, data: Buffer): CachedDeflated {
  const hit = deflateCache.get(oid);
  if (hit) return hit;
  const entry: CachedDeflated = {
    header: encodePackObjectHeader(TYPE_CODE[type], data.length),
    deflated: zlibDeflateSync(data),
  };
  if (deflateCache.size >= DEFLATE_CACHE_MAX) {
    const oldest = deflateCache.keys().next().value;
    if (oldest !== undefined) deflateCache.delete(oldest);
  }
  deflateCache.set(oid, entry);
  return entry;
}

export function writePack(objects: readonly GitObject[], oids?: readonly string[]): Buffer {
  const hash = createHash('sha1');
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  hash.update(header);
  parts.push(header);
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i]!;
    const oid = oids?.[i] ?? hashObject(object.type, object.data);
    const { header: objHeader, deflated } = deflatedObject(oid, object.type, object.data);
    hash.update(objHeader);
    hash.update(deflated);
    parts.push(objHeader, deflated);
  }
  const checksum = Buffer.from(hash.digest('hex'), 'hex');
  parts.push(checksum);
  return Buffer.concat(parts);
}

/**
 * Parse a packfile (plain objects plus OFS- and REF-deltas), verify its trailer
 * checksum, and return the objects by oid. `resolveBase` supplies objects that a
 * REF-delta may point at outside the pack (thin packs).
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  if (expected !== actual) throw new Error('pack checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  interface DeltaEntry {
    offset: number;
    typeCode: number;
    baseOid: string | null;
    baseOffset: number | null;
    delta: Buffer;
  }
  const pending = new Map<number, DeltaEntry>();
  let cursor = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = cursor;
    const { typeCode, size, endOffset } = decodePackObjectHeader(pack, cursor);
    cursor = endOffset;
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: a negative variable offset to the base entry.
      let byte = pack[cursor]!;
      cursor += 1;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[cursor]!;
        cursor += 1;
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - off;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(cursor, cursor + 20).toString('hex');
      cursor += 20;
    }
    const inflated = zlibInflateSync(pack.subarray(cursor), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    cursor += inflated.engine?.bytesWritten ?? 0;
    const data = inflated.buffer as Buffer;
    if (data.length !== size) throw new Error('pack object size mismatch');
    if (typeCode >= 1 && typeCode <= 4) {
      const type: GitObjectType = (['commit', 'tree', 'blob', 'tag'] as const)[typeCode - 1]!;
      const object: GitObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    } else if (typeCode === 6 || typeCode === 7) {
      pending.set(entryOffset, { offset: entryOffset, typeCode, baseOid, baseOffset, delta: data });
    } else {
      throw new Error(`unsupported pack object type ${typeCode}`);
    }
  }
  // Resolve deltas; chained deltas settle over repeated sweeps.
  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const [offset, entry] of [...pending.entries()]) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) base = byOffset.get(entry.baseOffset!);
      else if (entry.baseOid) base = objects.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
      if (!base) continue;
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, entry.delta) };
      const oid = hashObject(resolved.type, resolved.data);
      objects.set(oid, resolved);
      byOffset.set(offset, resolved);
      pending.delete(offset);
      progress = true;
    }
  }
  if (pending.size > 0) throw new Error('unresolvable delta in pack');
  return objects;
}

/** Reachable set from the given roots, walking commit->parent/tree/blob and tag->object. */
export function collectReachable(
  roots: readonly string[],
  lookup: (oid: string) => GitObject | undefined,
  include: { includeTreeBlobs: boolean } = { includeTreeBlobs: true },
): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object !== '') stack.push(tag.object);
    } else if (object.type === 'tree' && include.includeTreeBlobs) {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return seen;
}
