// Smart HTTP git transport: info/refs advertisements, ls-refs and fetch (v2 and
// v0 fallback), and receive-pack (push). The object model and pack codec live in
// gitcore; this file only turns wire requests into store operations.
//
// Every handler needs the bearer token (checked by the router first) and never
// touches the wall clock: object ids and timestamps come from the store.

import {
  DELIM_PKT,
  FLUSH_PKT,
  ZERO_OID,
  buildTag,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodeSideband,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type PktLine,
} from './gitcore.ts';
import type { Ctx } from './http.ts';
import { notFound, sendBuffer, sendMessage } from './http.ts';
import type { Repo } from './store.ts';
import { VIEWER } from './store.ts';

const AGENT = 'github-core-clone-01/1.0.0';
const UPLOAD_PACK_CAPS_V0 = [
  `symref=HEAD:refs/heads/main`,
  'multi_ack_detailed',
  'thin-pack',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'no-progress',
  'include-tag',
  `agent=${AGENT}`,
].join(' ');
const RECEIVE_PACK_CAPS_V0 = [
  `symref=HEAD:refs/heads/main`,
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  `agent=${AGENT}`,
].join(' ');

/** All refs of a repo as <oid, ref name> pairs, HEAD first, then sorted. */
function listRefs(repo: Repo): { oid: string; ref: string }[] {
  const out: { oid: string; ref: string }[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip) out.push({ oid: mainTip, ref: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    out.push({ oid: repo.refs.get(name)!, ref: name });
    // Peeled line for annotated tags.
    const object = repo.objects.get(repo.refs.get(name)!);
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      const peeled = parseTag(object.data).object;
      if (repo.objects.has(peeled)) out.push({ oid: peeled, ref: `${name}^{}` });
    }
  }
  if (!mainTip && names.length === 0) return out;
  return out;
}

function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const chunks: Buffer[] = [];
  const preamble = service === 'upload' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  chunks.push(encodePktLine(preamble));
  const caps = service === 'upload' ? UPLOAD_PACK_CAPS_V0 : RECEIVE_PACK_CAPS_V0;
  const refs = listRefs(repo);
  if (refs.length === 0) {
    chunks.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.ref}\0${caps}\n` : `${ref.oid} ${ref.ref}\n`;
      chunks.push(encodePktLine(line));
    });
  }
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

function v2Advertisement(): Buffer {
  const chunks: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    FLUSH_PKT,
  ];
  return Buffer.concat(chunks);
}

export function handleInfoRefs(ctx: Ctx, owner: string, name: string): void {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const service = ctx.url.searchParams.get('service') ?? '';
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, 'upload');
    sendBuffer(ctx, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(ctx, 200, v0Advertisement(repo, 'receive'), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendMessage(ctx, 400, `Unknown service: ${service}`);
}

// ---- ls-refs / fetch (v2 and v0) --------------------------------------------

interface FetchRequest {
  command: 'ls-refs' | 'fetch' | '';
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
  thinPack: boolean;
  noProgress: boolean;
  ofsDelta: boolean;
  objectFormat: string;
}

function parseCommandLines(lines: PktLine[]): FetchRequest {
  const request: FetchRequest = {
    command: '',
    peel: false,
    symrefs: false,
    unborn: false,
    prefixes: [],
    wants: [],
    haves: [],
    shallow: [],
    deepen: undefined,
    thinPack: false,
    noProgress: false,
    ofsDelta: false,
    objectFormat: '',
  };
  let afterDelim = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (line.kind !== 'data' || !line.data) continue;
    const text = line.data.toString('utf8');
    const trimmed = text.replace(/\n$/, '');
    const [key, ...rest] = trimmed.split(' ');
    if (!afterDelim) {
      if (key.startsWith('command=')) {
        const command = key.slice('command='.length);
        if (command === 'ls-refs' || command === 'fetch') request.command = command;
      } else if (key.startsWith('object-format=')) {
        request.objectFormat = key.slice('object-format='.length);
      }
      continue;
    }
    const value = rest.join(' ');
    if (key === 'peel') request.peel = true;
    else if (key === 'symrefs') request.symrefs = true;
    else if (key === 'unborn') request.unborn = true;
    else if (key === 'ref-prefix') request.prefixes.push(value);
    else if (key === 'want') request.wants.push(value);
    else if (key === 'have') request.haves.push(value);
    else if (key === 'shallow') request.shallow.push(value);
    else if (key === 'thin-pack') request.thinPack = true;
    else if (key === 'no-progress') request.noProgress = true;
    else if (key === 'ofs-delta') request.ofsDelta = true;
    else if (key === 'deepen' && value !== '') request.deepen = Number.parseInt(value, 10);
    // 'filter', 'deepen-since', 'deepen-not', 'done', 'agent' are ignored.
  }
  return request;
}

interface WalkResult {
  /** Every object reachable from the roots within the limits (commit/tree/blob/tag). */
  objects: Set<string>;
  /** Generation of each included commit (want = 1, parents increment). */
  commitGen: Map<string, number>;
}

/**
 * Depth-limited closure of the given wants. A commit at generation > depth is not
 * included; a tag want contributes its tag object and its target commit at the same
 * generation. Walking never descends past a commit listed in `stopAt` (that commit
 * is included, its parents are not).
 */
function walkFrom(
  repo: Repo,
  wants: readonly string[],
  depth: number | undefined,
  stopAt: ReadonlySet<string>,
): WalkResult {
  const objects = new Set<string>();
  const commitGen = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      objects.add(want);
      const tagged = parseTag(object.data).object;
      queue.push({ oid: tagged, gen: 1 });
    } else {
      queue.push({ oid: want, gen: 1 });
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      if (commitGen.has(oid)) continue;
      if (depth !== undefined && gen > depth) continue;
      commitGen.set(oid, gen);
      objects.add(oid);
      const commit = parseCommit(object.data);
      if (commit.tree !== '') objects.add(commit.tree);
      const treeBlobs = collectReachable([commit.tree], (candidate) => repo.objects.get(candidate));
      for (const entry of treeBlobs) objects.add(entry);
      if (stopAt.has(oid)) continue;
      if (depth === undefined || gen < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    } else if (object.type === 'tag') {
      objects.add(oid);
      const tagged = parseTag(object.data).object;
      queue.push({ oid: tagged, gen });
    } else {
      objects.add(oid);
    }
  }
  return { objects, commitGen };
}

/** The common ancestors of `tip` that are reachable without descending past a boundary. */
function truncateHeld(repo: Repo, haves: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  return walkFrom(repo, haves, undefined, stopAt).objects;
}

/** Whether `ancestor` is reachable from `tip` (an ancestor check for fast-forwards). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

function handleLsRefs(ctx: Ctx, repo: Repo, request: FetchRequest): void {
  const lines: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const matches = (ref: string): boolean =>
    request.prefixes.length === 0 || request.prefixes.some((prefix) => ref.startsWith(prefix));
  if (request.unborn && !mainTip) {
    lines.push(encodePktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else if (mainTip && matches('HEAD')) {
    const symref = request.symrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(encodePktLine(`${mainTip} HEAD${symref}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    // One line per ref: the peeled attribute rides on the same line (a second
    // line for the same ref would shadow it for a reader that takes the first).
    let suffix = '';
    if (request.peel) {
      const object = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && object?.type === 'tag') {
        const peeled = parseTag(object.data).object;
        if (repo.objects.has(peeled)) suffix = ` peeled:${peeled}`;
      }
    }
    lines.push(encodePktLine(`${oid} ${name}${suffix}\n`));
  }
  lines.push(FLUSH_PKT);
  sendBuffer(ctx, 200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
}

function handleFetchV2(ctx: Ctx, repo: Repo, request: FetchRequest): void {
  const shallowSet = new Set(request.shallow);
  // The wants walk is bounded only by the depth: a deepen request descends
  // past the client's shallow boundary on purpose, so the boundary never
  // stops it. Only the held walk stops at a shallow commit (the client
  // already has it; its parents are not held).
  const wantSet = walkFrom(repo, request.wants, request.deepen, new Set());
  const held = truncateHeld(repo, request.haves, shallowSet);
  const send = new Set<string>();
  for (const oid of wantSet.objects) {
    if (!held.has(oid)) send.add(oid);
  }
  const parts: Buffer[] = [];
  // acknowledgments (only when the client sent haves).
  if (request.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    const common = request.haves.filter((have) => repo.objects.has(have));
    if (common.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  // shallow-info: new boundaries at the depth edge, plus re-emitted old boundaries
  // whose parents the client still lacks; a boundary whose parents are now held
  // is reported as unshallow.
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (request.deepen !== undefined) {
    for (const [oid, gen] of wantSet.commitGen) {
      if (gen === request.deepen) shallowOut.push(oid);
    }
  }
  for (const boundary of request.shallow) {
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const allHeld = parents.every((parent) => held.has(parent) || wantSet.objects.has(parent));
    if (allHeld) unshallowOut.push(boundary);
    else if (!shallowOut.includes(boundary)) shallowOut.push(boundary);
  }
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  // packfile: always present, even when nothing is sent (an empty pack).
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...encodeSideband(1, writePack(objects)));
  parts.push(FLUSH_PKT);
  sendBuffer(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(ctx: Ctx, repo: Repo, request: FetchRequest): void {
  const shallowSet = new Set(request.shallow);
  // The wants walk is bounded only by the depth (see handleFetchV2).
  const wantSet = walkFrom(repo, request.wants, request.deepen, new Set());
  const held = truncateHeld(repo, request.haves, shallowSet);
  const send = new Set<string>();
  for (const oid of wantSet.objects) {
    if (!held.has(oid)) send.add(oid);
  }
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    const common = request.haves.filter((have) => repo.objects.has(have));
    if (common.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
  }
  if (request.deepen !== undefined) {
    for (const [oid, gen] of wantSet.commitGen) {
      if (gen === request.deepen) parts.push(encodePktLine(`shallow ${oid}\n`));
    }
  }
  for (const boundary of request.shallow) {
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const allHeld = parents.every((parent) => held.has(parent) || wantSet.objects.has(parent));
    if (allHeld) parts.push(encodePktLine(`unshallow ${boundary}\n`));
    else parts.push(encodePktLine(`shallow ${boundary}\n`));
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  parts.push(...encodeSideband(1, writePack(objects)));
  parts.push(FLUSH_PKT);
  sendBuffer(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

export function handleUploadPack(ctx: Ctx, owner: string, name: string): void {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const { lines } = decodePktLines(ctx.body);
  const request = parseCommandLines(lines);
  if (request.command === 'ls-refs') {
    handleLsRefs(ctx, repo, request);
    return;
  }
  if (request.command === 'fetch') {
    handleFetchV2(ctx, repo, request);
    return;
  }
  // No valid command: a v0 fetch body starts with `want` lines, not a command.
  const hasWant = lines.some(
    (line) => line.kind === 'data' && line.data?.toString('utf8').startsWith('want ') === true,
  );
  if (!hasWant) {
    // A malformed body must not kill the server; answer a plain 400.
    sendMessage(ctx, 400, 'Malformed git-upload-pack request');
    return;
  }
  // v0 fetch: re-parse the raw lines the v0 way.
  const v0: FetchRequest = {
    command: 'fetch',
    peel: false,
    symrefs: false,
    unborn: false,
    prefixes: [],
    wants: [],
    haves: [],
    shallow: [],
    deepen: undefined,
    thinPack: false,
    noProgress: false,
    ofsDelta: false,
    objectFormat: '',
  };
  let inHaves = false;
  for (const line of lines) {
    if (line.kind === 'flush') {
      inHaves = true;
      continue;
    }
    if (line.kind !== 'data' || !line.data) continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    const [key, value] = text.split(' ');
    const rest = value ?? '';
    if (key === 'want') v0.wants.push(rest);
    else if (key === 'have' && inHaves) v0.haves.push(rest);
    else if (key === 'shallow') v0.shallow.push(rest);
    else if (key === 'deepen') v0.deepen = Number.parseInt(rest, 10);
    else if (key === 'done') break;
  }
  handleFetchV0(ctx, repo, v0);
}

// ---- receive-pack (push) ----------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } | null {
  const { lines, endOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const line of lines) {
    if (line.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (line.kind !== 'data' || !line.data) continue;
    const text = line.data.toString('utf8');
    // First line may carry "\0<capabilities>" after the ref name.
    const nulAt = text.indexOf('\0');
    const commandText = nulAt === -1 ? text : text.slice(0, nulAt);
    const parts = commandText.trim().split(' ');
    if (parts.length !== 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (!sawFlush && commands.length === 0) return null;
  const pack = endOffset < body.length ? body.subarray(endOffset) : null;
  return { commands, pack };
}

export function handleReceivePack(ctx: Ctx, owner: string, name: string): void {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const parsed = parsePushBody(ctx.body);
  const report: string[] = [];
  if (parsed === null || parsed.commands.length === 0) {
    report.push('unpack ok');
  } else {
    let unpackDetail: string | null = null;
    if (parsed.pack && parsed.pack.length > 0) {
      try {
        const objects = readPack(parsed.pack, (oid) => repo.objects.get(oid));
        // Store through the store so commit insertion order (used by history)
        // stays consistent across the git and REST surfaces.
        for (const object of objects.values()) {
          ctx.store.storeObject(repo, object.type, object.data);
        }
      } catch (error) {
        unpackDetail = error instanceof Error ? error.message : 'invalid packfile';
      }
    }
    if (unpackDetail !== null) {
      report.push(`unpack ${unpackDetail}`);
    } else {
      report.push('unpack ok');
      for (const command of parsed.commands) {
        const current = repo.refs.get(command.ref);
        const isCreate = command.oldOid === ZERO_OID;
        const isDelete = command.newOid === ZERO_OID;
        if (isCreate) {
          if (current !== undefined) {
            report.push(`ng ${command.ref} non-fast-forward`);
          } else if (!repo.objects.has(command.newOid)) {
            report.push(`ng ${command.ref} object not found`);
          } else {
            repo.refs.set(command.ref, command.newOid);
            report.push(`ok ${command.ref}`);
          }
        } else if (isDelete) {
          if (current === undefined || current !== command.oldOid) {
            report.push(`ng ${command.ref} non-fast-forward`);
          } else {
            repo.refs.delete(command.ref);
            report.push(`ok ${command.ref}`);
          }
        } else {
          if (current === undefined || current !== command.oldOid) {
            report.push(`ng ${command.ref} non-fast-forward`);
          } else if (!repo.objects.has(command.newOid)) {
            report.push(`ng ${command.ref} object not found`);
          } else if (command.newOid !== command.oldOid && !isAncestor(repo, command.oldOid, command.newOid)) {
            report.push(`ng ${command.ref} non-fast-forward`);
          } else {
            repo.refs.set(command.ref, command.newOid);
            report.push(`ok ${command.ref}`);
          }
        }
      }
    }
  }
  const payload = Buffer.from(`${report.join('\n')}\n`, 'utf8');
  const parts: Buffer[] = [...encodeSideband(1, payload), FLUSH_PKT];
  sendBuffer(ctx, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// Re-export for the rare case a checker needs a tag built through the server.
export function buildAnnotatedTag(
  objectOid: string,
  type: GitObjectType,
  tagName: string,
  message: string,
  epochSec: number,
): string {
  const data = buildTag({
    object: objectOid,
    type,
    tag: tagName,
    tagger: { name: VIEWER.name, email: VIEWER.email, epoch: epochSec, tz: '+0000' },
    message,
  });
  return hashObject('tag', data);
}
