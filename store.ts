// The forge's in-memory store. One Store per process holds every repo, object,
// issue, pull request and label; the REST, GraphQL, MCP and git surfaces all read
// and write through it, so a repo created over MCP reads back over /api/v3 and a
// commit pushed over git is visible to every surface.

import {
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type Commit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { globalId, isoOfEpoch, lineDiff } from './util.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1000?v=4',
  type: 'User',
};



export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdSeq: number;
  closedAt: string | null;
  updatedSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdSeq: number;
  userLogin: string;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  userLogin: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  /** Ref name (refs/heads/x, refs/tags/y) -> commit/tag oid. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment>;
  /** One shared sequence for issues and pull requests, starting at 1. */
  nextNumber: number;
  /** Byte length of file content is derived; commit insertion order for history. */
  commitSeq: Map<string, number>;
  /** Commit oid -> parent oids, parsed once at store time (never re-parsed). */
  commitParents: Map<string, string[]>;
  /** Commit oid -> generation (longest path to a root), computed lazily, memoized. */
  commitGen: Map<string, number>;
}

export class Store {
  readonly trialEpochSec: number;
  readonly trialNowIso: string;
  private repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentIdValue = 1;
  private seq = 1;
  private requestSeq = 1;

  constructor(trialEpochSec: number, trialNowIso: string) {
    this.trialEpochSec = trialEpochSec;
    this.trialNowIso = trialNowIso;
  }

  /** Deterministic request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    return `req-${this.requestSeq.toString(16).padStart(12, '0')}`;
  }

  /** A fresh global comment id (integers >= 1, stable once assigned). */
  nextCommentId(): number {
    return this.nextCommentIdValue++;
  }

  /** A fresh creation sequence for a comment. */
  nextCommentSeq(): number {
    return this.newSeq();
  }

  private newSeq(): number {
    return this.seq++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}\0${name.toLowerCase()}`;
  }

  listReposByOwner(owner: string): Repo[] {
    const lower = owner.toLowerCase();
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === lower) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** Every repo the store holds, in creation order. */
  listAllRepos(): Repo[] {
    const out = [...this.repos.values()];
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  hasRepo(owner: string, name: string): boolean {
    return this.repos.has(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description = '', isPrivate = false): Repo | null {
    if (this.hasRepo(owner, name)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.newSeq(),
      objects: new Map(),
      refs: new Map(),
      // A fresh repo starts with NO labels: the suite creates them through
      // POST /labels (and expects 201), and an unknown label makes issue
      // creation fail with 422.
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      commitSeq: new Map(),
      commitParents: new Map(),
      commitGen: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // ---- git objects ---------------------------------------------------------

  storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    return this.storeObjectWithOid(repo, type, data, oid);
  }

  /** Store an object whose oid is already known (e.g. from readPack): skips the re-hash. */
  storeObjectWithOid(repo: Repo, type: GitObjectType, data: Buffer, oid: string): string {
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') {
        repo.commitSeq.set(oid, this.newSeq());
        repo.commitParents.set(oid, parseCommit(data).parents);
      }
    }
    return oid;
  }

  lookupObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref name (short or full), a pull ref, or a full oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const full = `refs/heads/${ref}`;
    if (repo.refs.has(full)) return repo.refs.get(full)!;
    const tagFull = `refs/tags/${ref}`;
    if (repo.refs.has(tagFull)) return repo.refs.get(tagFull)!;
    if (repo.objects.has(ref)) return ref;
    return null;
  }

  refTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit a ref points at (peeling an annotated tag when needed). */
  commitAt(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') return this.commitAt(repo, parseTag(object.data).object);
    return null;
  }

  treeOf(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** A commit history walk, newest first by commit order (newest commit first). */
  commitHistory(repo: Repo, tipOid: string, limit?: number): string[] {
    const out: string[] = [];
    const visited = new Set<string>();
    const stack: string[] = [tipOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) stack.push(parent);
    }
    out.sort(
      (a, b) =>
        (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0),
    );
    return limit === undefined ? out : out.slice(0, limit);
  }

  /** A flattened path -> {oid, mode} map of a tree, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree with one path replaced by a blob, or removed. */
  setPathInTree(
    repo: Repo,
    treeOid: string | null,
    path: string,
    blobOid: string | null,
  ): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (currentOid: string | null, depth: number): string => {
      const current = currentOid === null ? [] : parseTree(repo.objects.get(currentOid)?.data ?? Buffer.alloc(0));
      const segment = segments[depth]!;
      const isLeaf = depth === segments.length - 1;
      const entries = current.filter((entry) => entry.name !== segment);
      if (isLeaf) {
        if (blobOid !== null) entries.push({ mode: '100644', name: segment, oid: blobOid });
        return this.storeObject(repo, 'tree', buildTree(entries));
      }
      const child = current.find((entry) => entry.name === segment && entry.mode === '40000');
      if (blobOid === null && !child) return this.storeObject(repo, 'tree', buildTree(entries));
      const childOid = build(child ? child.oid : null, depth + 1);
      const childEntries = parseTree(repo.objects.get(childOid)?.data ?? Buffer.alloc(0));
      if (childEntries.length === 0 && blobOid === null) {
        return this.storeObject(repo, 'tree', buildTree(entries));
      }
      entries.push({ mode: '40000', name: segment, oid: childOid });
      return this.storeObject(repo, 'tree', buildTree(entries));
    };
    return build(treeOid, 0);
  }

  /** The oid of a file in a tree, or null. */
  fileAt(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const flat = this.flattenTree(repo, treeOid);
    return flat.get(path) ?? null;
  }

  /** Create a commit on a ref, or on an unborn ref (no parent), and move the ref. */
  createCommit(
    repo: Repo,
    ref: string,
    message: string,
    treeOid: string,
  ): { commitOid: string } {
    const parent = repo.refs.get(ref);
    const commit: Commit = {
      tree: treeOid,
      parents: parent ? [parent] : [],
      author: { name: VIEWER.name, email: VIEWER.email, epoch: this.trialEpochSec, tz: '+0000' },
      committer: { name: VIEWER.name, email: VIEWER.email, epoch: this.trialEpochSec, tz: '+0000' },
      message,
    };
    const commitOid = this.storeObject(repo, 'commit', buildCommit(commit));
    repo.refs.set(ref, commitOid);
    return { commitOid };
  }

  /** First common ancestor of two commits, or null (unrelated histories). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOf = (tip: string): Map<string, number> => {
      const depths = new Map<string, number>();
      const queue: { oid: string; depth: number }[] = [{ oid: tip, depth: 0 }];
      while (queue.length > 0) {
        const { oid, depth } = queue.shift()!;
        if (depths.has(oid)) continue;
        depths.set(oid, depth);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          queue.push({ oid: parent, depth: depth + 1 });
        }
      }
      return depths;
    };
    const aAncestors = ancestorsOf(a);
    const bAncestors = ancestorsOf(b);
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    for (const [oid, depthA] of aAncestors) {
      const depthB = bAncestors.get(oid);
      if (depthB === undefined) continue;
      const combined = depthA + depthB;
      if (combined < bestDepth) {
        bestDepth = combined;
        best = oid;
      }
    }
    return best;
  }

  /** Paths that differ between two trees (added/modified/removed at content level). */
  treeChanges(repo: Repo, baseTree: string, headTree: string): Map<string, string | null> {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const changed = new Map<string, string | null>();
    for (const [path, entry] of head) {
      const other = base.get(path);
      if (!other || other.oid !== entry.oid) changed.set(path, entry.oid);
    }
    for (const path of base.keys()) {
      if (!head.has(path)) changed.set(path, null);
    }
    return changed;
  }

  /** Three-way merge-conflict test for a pull request. */
  hasMergeConflict(repo: Repo, pull: Pull): boolean {
    const headCommit = pull.headSha;
    const baseCommit = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(repo, headCommit, baseCommit);
    if (!base) return false;
    const headTree = this.treeOf(repo, headCommit);
    const baseTipTree = this.treeOf(repo, baseCommit);
    const baseTree = this.treeOf(repo, base);
    if (!headTree || !baseTipTree || !baseTree) return false;
    const headChanges = this.treeChanges(repo, baseTree, headTree);
    const baseChanges = this.treeChanges(repo, baseTree, baseTipTree);
    for (const [path, headOid] of headChanges) {
      if (baseChanges.has(path) && baseChanges.get(path) !== headOid) return true;
    }
    return false;
  }

  /** File-level diff between two trees (base tip vs head tip), for the files API. */
  treeDiffFiles(
    repo: Repo,
    baseTree: string,
    headTree: string,
  ): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const flatBase = this.flattenTree(repo, baseTree);
    const flatHead = this.flattenTree(repo, headTree);
    const paths = new Set([...flatBase.keys(), ...flatHead.keys()]);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = flatBase.get(path);
      const newEntry = flatHead.get(path);
      if (!oldEntry || !newEntry || oldEntry.oid !== newEntry.oid) {
        const oldText = oldEntry
          ? (repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0)).toString('utf8')
          : '';
        const newText = newEntry
          ? (repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0)).toString('utf8')
          : '';
        const counts = lineDiff(oldText, newText);
        const status = !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified';
        out.push({
          filename: path,
          status,
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        });
      }
    }
    return out;
  }

  reachableOids(repo: Repo, roots: readonly string[]): Set<string> {
    return collectReachable(roots, (oid) => repo.objects.get(oid));
  }

  // ---- issues / pulls ------------------------------------------------------

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labelNames: string[],
  ): Issue | { error: string; status: number } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) {
        return { error: `Label does not exist: ${name}`, status: 422 };
      }
    }
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      userLogin: VIEWER.login,
      createdSeq: this.newSeq(),
      closedAt: null,
      updatedSeq: this.newSeq(),
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): Pull | { error: string; status: number } {
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    if (!headTip) return { error: `Head branch not found: ${headRef}`, status: 422 };
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (!baseTip) return { error: `Base branch not found: ${baseRef}`, status: 422 };
    for (const existing of repo.pulls.values()) {
      if (
        existing.state === 'open' &&
        existing.headRef === headRef &&
        existing.baseRef === baseRef
      ) {
        return { error: 'A pull request already exists for this head and base', status: 422 };
      }
    }
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha: headTip,
      baseRef,
      baseSha: baseTip,
      createdSeq: this.newSeq(),
      userLogin: VIEWER.login,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Merge a pull request by squash. Returns the merge commit oid on success. */
  mergePull(
    repo: Repo,
    pull: Pull,
  ): { ok: true; sha: string } | { ok: false; status: number; error: string } {
    if (pull.state !== 'open') {
      return { ok: false, status: 405, error: 'Pull request is already closed' };
    }
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return { ok: false, status: 422, error: `Base branch not found: ${pull.baseRef}` };
    if (headTip === baseTip) {
      return { ok: false, status: 405, error: 'Head and base are the same' };
    }
    if (this.hasMergeConflict(repo, pull)) {
      return { ok: false, status: 405, error: 'Merge conflict' };
    }
    const headTree = this.treeOf(repo, headTip);
    if (!headTree) return { ok: false, status: 422, error: 'Head commit has no tree' };
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commit: Commit = {
      tree: headTree,
      parents: [baseTip],
      author: { name: VIEWER.name, email: VIEWER.email, epoch: this.trialEpochSec, tz: '+0000' },
      committer: { name: VIEWER.name, email: VIEWER.email, epoch: this.trialEpochSec, tz: '+0000' },
      message,
    };
    const sha = this.storeObject(repo, 'commit', buildCommit(commit));
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.trialNowIso;
    pull.mergeCommitSha = sha;
    return { ok: true, sha };
  }

  globalIds = {
    repository: (repo: Repo): string => globalId('Repository', repo.id),
    issue: (repo: Repo, issue: Issue): string => globalId('Issue', repo.id, issue.number),
    pull: (repo: Repo, pull: Pull): string => globalId('PullRequest', repo.id, pull.number),
    comment: (repo: Repo, comment: Comment): string =>
      globalId('IssueComment', repo.id, comment.id),
    user: (): string => globalId('User', VIEWER.id),
  };

  labelColor(repo: Repo, name: string): string {
    return repo.labels.get(name)?.color ?? 'ededed';
  }
}

export function issueJson(repo: Repo, issue: Issue, store: Store): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: store.labelColor(repo, name) })),
    user: { login: issue.userLogin, id: VIEWER.id, type: 'User' },
    created_at: store.trialNowIso,
    updated_at: store.trialNowIso,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function repoJson(repo: Repo, store: Store): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: repo.owner === VIEWER.login ? VIEWER.id : repo.id,
      type: repo.owner.startsWith('faint-') ? 'Organization' : 'User',
      avatar_url: VIEWER.avatarUrl,
    },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.trialNowIso,
    updated_at: store.trialNowIso,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: '',
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
  };
}

export function pullJson(repo: Repo, pull: Pull, store: Store): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    user: { login: pull.userLogin, id: VIEWER.id, type: 'User' },
    created_at: store.trialNowIso,
    updated_at: store.trialNowIso,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}
