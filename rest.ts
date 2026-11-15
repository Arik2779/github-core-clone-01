// REST API v3. Every reply is application/json and carries X-GitHub-Request-Id;
// errors are {message}; a repo under another owner is 404, never 403.

import { parseCommit, parseTree } from './gitcore.ts';
import type { Ctx, JsonObject } from './http.ts';
import {
  badRequest,
  booleanField,
  intField,
  notFound,
  parseJsonObject,
  queryInt,
  sendJson,
  sendMessage,
  stringField,
  unprocessable,
} from './http.ts';
import type { Repo } from './store.ts';
import { VIEWER, issueJson, pullJson, repoJson } from './store.ts';
import { b64decodeText, b64encodeBytes, isoOfEpoch, isValidName } from './util.ts';

function originOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function repoRef(ctx: Ctx, owner: string, name: string): Repo | undefined {
  return ctx.store.getRepo(owner, name);
}

/** A JSON object for one commit, newest-first ordering done by the caller. */
function commitJson(repo: Repo, oid: string, ctx: Ctx): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const parsed = object && object.type === 'commit' ? parseCommit(object.data) : null;
  const message = parsed?.message ?? '';
  const author = parsed?.author ?? { name: VIEWER.name, email: VIEWER.email, epoch: ctx.store.trialEpochSec, tz: '+0000' };
  const committer = parsed?.committer ?? author;
  return {
    sha: oid,
    commit: {
      message,
      author: { name: author.name, email: author.email, date: isoOfEpoch(author.epoch) },
      committer: { name: committer.name, email: committer.email, date: isoOfEpoch(committer.epoch) },
      tree: { sha: parsed?.tree ?? '' },
    },
    parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
    author: { login: author.email === VIEWER.email ? VIEWER.login : author.name, id: VIEWER.id, type: 'User' },
    committer: { login: committer.email === VIEWER.email ? VIEWER.login : committer.name, id: VIEWER.id, type: 'User' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

/** Resolve a ref query (branch name, full ref or oid) to a commit oid. */
function resolveCommitRef(repo: Repo, ctx: Ctx, ref: string): string | null {
  const direct = ctx.store.resolveRef(repo, ref);
  if (direct) {
    const peeled = ctx.store.commitAt(repo, direct);
    if (peeled) return peeled;
    if (repo.objects.get(direct)?.type === 'commit') return direct;
    return null;
  }
  return null;
}

function paginationLinks(ctx: Ctx, page: number, perPage: number, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const base = `${originOf(ctx)}${ctx.url.pathname}`;
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  }
  if (lastPage > 1) {
    links.push(`<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  }
  return links.length > 0 ? { Link: links.join(', ') } : {};
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// ---- user-level -------------------------------------------------------------

function getUserRepos(ctx: Ctx): void {
  const perPage = queryInt(ctx, 'per_page', 30);
  const page = Math.max(1, queryInt(ctx, 'page', 1));
  const repos = ctx.store.listReposByOwner(VIEWER.login);
  sendJson(ctx, 200, paginate(repos, page, perPage).map((repo) => repoJson(repo, ctx.store)), paginationLinks(ctx, page, perPage, repos.length));
}

function createUserRepo(ctx: Ctx): void {
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const name = stringField(body, 'name');
  if (name === '' || !isValidName(name)) {
    unprocessable(ctx, 'name is required');
    return;
  }
  if (ctx.store.hasRepo(VIEWER.login, name)) {
    unprocessable(ctx, 'name already exists on this account');
    return;
  }
  const repo = ctx.store.createRepo(
    VIEWER.login,
    name,
    stringField(body, 'description'),
    booleanField(body, 'private', false),
  )!;
  sendJson(ctx, 201, repoJson(repo, ctx.store));
}

// ---- repo-level -------------------------------------------------------------

function getRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  sendJson(ctx, 200, repoJson(repo, ctx.store));
}

function patchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  sendJson(ctx, 200, repoJson(repo, ctx.store));
}

function deleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  ctx.store.deleteRepo(owner, name);
  sendJson(ctx, 204, {});
}

// ---- refs / branches ----------------------------------------------------------

function createRef(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (!ref.startsWith('refs/')) {
    unprocessable(ctx, 'Invalid ref format');
    return;
  }
  if (repo.refs.has(ref)) {
    unprocessable(ctx, 'Reference already exists');
    return;
  }
  if (!repo.objects.has(sha)) {
    unprocessable(ctx, 'Object does not exist');
    return;
  }
  repo.refs.set(ref, sha);
  const object = repo.objects.get(sha)!;
  sendJson(ctx, 201, {
    ref,
    node_id: `ref:${ref}`,
    url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`,
    object: { sha, type: object.type },
  });
}

function listRefs(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const refs = [...repo.refs.keys()].sort().map((ref) => {
    const oid = repo.refs.get(ref)!;
    const object = repo.objects.get(oid);
    return { ref, node_id: `ref:${ref}`, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha: oid, type: object?.type ?? 'commit' } };
  });
  sendJson(ctx, 200, refs);
}

function getRef(ctx: Ctx, owner: string, name: string, refPath: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (!oid) {
    notFound(ctx, `Reference not found: ${ref}`);
    return;
  }
  const object = repo.objects.get(oid);
  sendJson(ctx, 200, {
    ref,
    node_id: `ref:${ref}`,
    url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`,
    object: { sha: oid, type: object?.type ?? 'commit' },
    sha: oid,
    commit: { sha: oid },
  });
}

function listBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    const branch = ref.slice('refs/heads/'.length);
    branches.push({
      name: branch,
      commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
      protected: false,
    });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(ctx, 200, branches);
}

function getBranch(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) {
    notFound(ctx, `Branch not found: ${branch}`);
    return;
  }
  sendJson(ctx, 200, {
    name: branch,
    commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
    protected: false,
  });
}

// ---- commits ---------------------------------------------------------------

function listCommits(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const ref = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = resolveCommitRef(repo, ctx, ref);
  if (!tip) {
    sendJson(ctx, 200, []);
    return;
  }
  const history = ctx.store.commitHistory(repo, tip);
  sendJson(ctx, 200, history.map((oid) => commitJson(repo, oid, ctx)));
}

// ---- contents ----------------------------------------------------------------

function getContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = resolveCommitRef(repo, ctx, ref);
  if (!tip) {
    notFound(ctx, `Reference not found: ${ref}`);
    return;
  }
  const treeOid = ctx.store.treeOf(repo, tip);
  if (!treeOid) {
    notFound(ctx, `No tree for ref: ${ref}`);
    return;
  }
  const flat = ctx.store.flattenTree(repo, treeOid);
  if (path === '') {
    const entries = entriesOfTree(repo, treeOid, '');
    sendJson(ctx, 200, entries);
    return;
  }
  const file = flat.get(path);
  if (file) {
    const blob = repo.objects.get(file.oid);
    const bytes = blob?.data ?? Buffer.alloc(0);
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: path.split('/').pop() ?? path,
      path,
      content: b64encodeBytes(bytes),
      sha: file.oid,
      url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
      html_url: `https://github.com/${owner}/${name}/blob/${ref}/${path}`,
      download_url: `${originOf(ctx)}/raw/${owner}/${name}/${ref}/${path}`,
    });
    return;
  }
  // A directory: any file under path/.
  const prefix = `${path}/`;
  const children = new Map<string, { name: string; type: string; oid: string; path: string }>();
  for (const [filePath, entry] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const first = rest.split('/')[0]!;
    if (!children.has(first)) {
      children.set(first, {
        name: first,
        type: rest.includes('/') ? 'dir' : 'file',
        oid: rest.includes('/') ? '' : entry.oid,
        path: `${path}/${first}`,
      });
    }
  }
  if (children.size === 0) {
    notFound(ctx, `Path not found: ${path}`);
    return;
  }
  sendJson(
    ctx,
    200,
    [...children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => ({
        type: child.type,
        size: child.type === 'file' ? (repo.objects.get(child.oid)?.data.length ?? 0) : 0,
        name: child.name,
        path: child.path,
        sha: child.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${child.path}`,
        html_url: `https://github.com/${owner}/${name}/tree/${ref}/${child.path}`,
      })),
  );
}

function entriesOfTree(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const entries: Record<string, unknown>[] = [];
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const isDir = entry.mode === '40000';
    entries.push({
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${path}`,
    });
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return entries;
}

function upsertContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const message = stringField(body, 'message');
  const content = stringField(body, 'content');
  if (message === '' || content === '') {
    unprocessable(ctx, 'message and content are required');
    return;
  }
  const bytes = b64decodeText(content);
  const branch = stringField(body, 'branch') || repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const expectedSha = stringField(body, 'sha');
  // Create the branch at the default branch tip when it does not exist yet.
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined && ref !== `refs/heads/${repo.defaultBranch}`) {
      repo.refs.set(ref, defaultTip);
    }
    tip = repo.refs.get(ref);
  }
  const currentTree = tip ? ctx.store.treeOf(repo, tip) : null;
  const currentFile = currentTree ? ctx.store.fileAt(repo, currentTree, path) : null;
  if (expectedSha !== '') {
    if (!currentFile || currentFile.oid !== expectedSha) {
      sendMessage(ctx, 409, 'sha does not match the current blob');
      return;
    }
  }
  const blobOid = ctx.store.storeObject(repo, 'blob', bytes);
  const newTree = ctx.store.setPathInTree(repo, currentTree, path, blobOid);
  const { commitOid } = ctx.store.createCommit(repo, ref, message, newTree);
  const isUpdate = currentFile !== null;
  sendJson(ctx, isUpdate ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const message = stringField(body, 'message');
  const expectedSha = stringField(body, 'sha');
  const branch = stringField(body, 'branch') || repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (!tip) {
    notFound(ctx, `Reference not found: ${branch}`);
    return;
  }
  const treeOid = ctx.store.treeOf(repo, tip);
  if (!treeOid) {
    notFound(ctx, `No tree for ref: ${branch}`);
    return;
  }
  const currentFile = ctx.store.fileAt(repo, treeOid, path);
  if (!currentFile) {
    notFound(ctx, `Path not found: ${path}`);
    return;
  }
  if (expectedSha !== '' && currentFile.oid !== expectedSha) {
    sendMessage(ctx, 409, 'sha does not match the current blob');
    return;
  }
  const newTree = ctx.store.setPathInTree(repo, treeOid, path, null);
  const { commitOid } = ctx.store.createCommit(repo, ref, message, newTree);
  sendJson(ctx, 200, { commit: { sha: commitOid, message } });
}

// ---- labels ------------------------------------------------------------------

function listLabels(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  sendJson(
    ctx,
    200,
    [...repo.labels.values()].map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description,
      url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(label.name)}`,
    })),
  );
}

function createLabel(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const labelName = stringField(body, 'name');
  const color = stringField(body, 'color') || 'ededed';
  if (labelName === '') {
    unprocessable(ctx, 'name is required');
    return;
  }
  if (repo.labels.has(labelName)) {
    unprocessable(ctx, 'Label already exists');
    return;
  }
  const label = { name: labelName, color, description: stringField(body, 'description') };
  repo.labels.set(labelName, label);
  sendJson(ctx, 201, {
    name: label.name,
    color: label.color,
    description: label.description,
    url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(labelName)}`,
  });
}

// ---- issues -----------------------------------------------------------------

function parseLabelList(body: JsonObject | null): string[] {
  if (!body) return [];
  const value = body.labels;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function createIssue(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const title = stringField(body, 'title');
  if (title === '') {
    unprocessable(ctx, 'title is required');
    return;
  }
  const result = ctx.store.createIssue(repo, title, stringField(body, 'body'), parseLabelList(body));
  if ('error' in result) {
    unprocessable(ctx, result.error);
    return;
  }
  sendJson(ctx, 201, issueJson(repo, result, ctx.store));
}

function listIssues(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') {
    issues = issues.filter((issue) => issue.state === state);
  }
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const perPage = queryInt(ctx, 'per_page', 30);
  const page = Math.max(1, queryInt(ctx, 'page', 1));
  sendJson(ctx, 200, paginate(issues, page, perPage).map((issue) => issueJson(repo, issue, ctx.store)), paginationLinks(ctx, page, perPage, issues.length));
}

function getIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const issue = repo.issues.get(number);
  if (!issue) {
    notFound(ctx, `Issue not found: ${number}`);
    return;
  }
  sendJson(ctx, 200, issueJson(repo, issue, ctx.store));
}

function patchIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const issue = repo.issues.get(number);
  if (!issue) {
    notFound(ctx, `Issue not found: ${number}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? ctx.store.trialNowIso : null;
  }
  sendJson(ctx, 200, issueJson(repo, issue, ctx.store));
}

function listComments(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  if (!repo.issues.has(number)) {
    notFound(ctx, `Issue not found: ${number}`);
    return;
  }
  const comments = [...repo.comments.values()]
    .filter((comment) => comment.issueNumber === number)
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: comment.userLogin, id: VIEWER.id, type: 'User' },
      created_at: ctx.store.trialNowIso,
      updated_at: ctx.store.trialNowIso,
      url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
    }));
  sendJson(ctx, 200, comments);
}

function createComment(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  if (!repo.issues.has(number)) {
    notFound(ctx, `Issue not found: ${number}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const text = stringField(body, 'body');
  if (text === '') {
    unprocessable(ctx, 'body is required');
    return;
  }
  const comment = {
    id: ctx.store.nextCommentId(),
    issueNumber: number,
    body: text,
    userLogin: VIEWER.login,
    createdSeq: ctx.store.nextCommentSeq(),
  };
  repo.comments.set(comment.id, comment);
  sendJson(ctx, 201, {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER.id, type: 'User' },
    created_at: ctx.store.trialNowIso,
    updated_at: ctx.store.trialNowIso,
    url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
  });
}

// ---- pulls -------------------------------------------------------------------

function createPull(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const title = stringField(body, 'title');
  const headRef = stringField(body, 'head');
  const baseRef = stringField(body, 'base');
  if (title === '' || headRef === '' || baseRef === '') {
    unprocessable(ctx, 'title, head and base are required');
    return;
  }
  const result = ctx.store.createPull(repo, title, stringField(body, 'body'), headRef, baseRef);
  if ('error' in result) {
    unprocessable(ctx, result.error);
    return;
  }
  sendJson(ctx, 201, pullJson(repo, result, ctx.store));
}

function listPulls(ctx: Ctx, owner: string, name: string): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  if (state !== 'all') {
    pulls = pulls.filter((pull) => pull.state === state);
  }
  sendJson(ctx, 200, pulls.map((pull) => pullJson(repo, pull, ctx.store)));
}

function getPull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    notFound(ctx, `Pull request not found: ${number}`);
    return;
  }
  sendJson(ctx, 200, pullJson(repo, pull, ctx.store));
}

function listPullFiles(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    notFound(ctx, `Pull request not found: ${number}`);
    return;
  }
  const baseTree = ctx.store.treeOf(repo, pull.baseSha);
  const headTree = ctx.store.treeOf(repo, pull.headSha);
  if (!baseTree || !headTree) {
    sendJson(ctx, 200, []);
    return;
  }
  const files = ctx.store.treeDiffFiles(repo, baseTree, headTree).map((file) => {
    // The sha of the file as it stands on the head side (on the base side when
    // the file was removed).
    const headFile = ctx.store.fileAt(repo, headTree, file.filename);
    const baseFile = ctx.store.fileAt(repo, baseTree, file.filename);
    const sha = (headFile ?? baseFile)?.oid ?? '';
    return {
      sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    };
  });
  sendJson(ctx, 200, files);
}

function mergePull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoRef(ctx, owner, name);
  if (!repo) {
    notFound(ctx, `Repository not found: ${owner}/${name}`);
    return;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    notFound(ctx, `Pull request not found: ${number}`);
    return;
  }
  const body = parseJsonObject(ctx);
  if (body === null) {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  const result = ctx.store.mergePull(repo, pull);
  if (!result.ok) {
    sendMessage(ctx, result.status, result.error);
    return;
  }
  sendJson(ctx, 200, {
    sha: result.sha,
    merged: true,
    message: 'Pull Request successfully merged',
    merge_commit_sha: result.sha,
  });
}

// ---- dispatcher ---------------------------------------------------------------

export function handleRest(ctx: Ctx): boolean {
  const segments = ctx.segments;
  const method = ctx.req.method ?? 'GET';
  // /api/v3/ (root), /api/v3/meta, /api/v3/user, /api/v3/user/repos
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (segments.length === 2) {
      if (method !== 'GET') {
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      sendJson(ctx, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      }, { 'X-OAuth-Scopes': 'repo, read:org' });
      return true;
    }
    if (segments[2] === 'meta' && segments.length === 3) {
      if (method !== 'GET') {
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      sendJson(ctx, 200, { installed_version: '1.0.0' });
      return true;
    }
    if (segments[2] === 'user' && segments.length === 3) {
      if (method !== 'GET') {
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      sendJson(ctx, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        avatar_url: VIEWER.avatarUrl,
        url: '/api/v3/user',
        html_url: `https://github.com/${VIEWER.login}`,
      });
      return true;
    }
    if (segments[2] === 'user' && segments[3] === 'repos' && segments.length === 4) {
      if (method === 'GET') {
        getUserRepos(ctx);
        return true;
      }
      if (method === 'POST') {
        createUserRepo(ctx);
        return true;
      }
      sendMessage(ctx, 405, 'Method not allowed');
      return true;
    }
    if (segments[2] === 'repos' && segments.length >= 5) {
      const owner = segments[3]!;
      const name = segments[4]!;
      const rest = segments.slice(5);
      if (rest.length === 0) {
        if (method === 'GET') {
          getRepo(ctx, owner, name);
          return true;
        }
        if (method === 'PATCH') {
          patchRepo(ctx, owner, name);
          return true;
        }
        if (method === 'DELETE') {
          deleteRepo(ctx, owner, name);
          return true;
        }
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (rest.length === 2 && method === 'GET') {
          listRefs(ctx, owner, name);
          return true;
        }
        if (rest.length === 2 && method === 'POST') {
          createRef(ctx, owner, name);
          return true;
        }
        if (rest.length >= 3 && method === 'GET') {
          getRef(ctx, owner, name, rest.slice(2).join('/'));
          return true;
        }
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      if (rest[0] === 'branches') {
        if (rest.length === 1 && method === 'GET') {
          listBranches(ctx, owner, name);
          return true;
        }
        if (rest.length >= 2 && method === 'GET') {
          getBranch(ctx, owner, name, rest.slice(1).join('/'));
          return true;
        }
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
        listCommits(ctx, owner, name);
        return true;
      }
      if (rest[0] === 'contents') {
        const path = rest.slice(1).join('/');
        if (method === 'GET') {
          getContents(ctx, owner, name, path);
          return true;
        }
        if (method === 'PUT') {
          upsertContents(ctx, owner, name, path);
          return true;
        }
        if (method === 'DELETE') {
          deleteContents(ctx, owner, name, path);
          return true;
        }
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      if (rest[0] === 'labels') {
        if (rest.length === 1 && method === 'GET') {
          listLabels(ctx, owner, name);
          return true;
        }
        if (rest.length === 1 && method === 'POST') {
          createLabel(ctx, owner, name);
          return true;
        }
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      if (rest[0] === 'issues') {
        if (rest.length === 1 && method === 'GET') {
          listIssues(ctx, owner, name);
          return true;
        }
        if (rest.length === 1 && method === 'POST') {
          createIssue(ctx, owner, name);
          return true;
        }
        const number = Number.parseInt(rest[1] ?? '', 10);
        if (Number.isFinite(number)) {
          if (rest.length === 2 && method === 'GET') {
            getIssue(ctx, owner, name, number);
            return true;
          }
          if (rest.length === 2 && method === 'PATCH') {
            patchIssue(ctx, owner, name, number);
            return true;
          }
          if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
            listComments(ctx, owner, name, number);
            return true;
          }
          if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
            createComment(ctx, owner, name, number);
            return true;
          }
        }
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
      if (rest[0] === 'pulls') {
        if (rest.length === 1 && method === 'GET') {
          listPulls(ctx, owner, name);
          return true;
        }
        if (rest.length === 1 && method === 'POST') {
          createPull(ctx, owner, name);
          return true;
        }
        const number = Number.parseInt(rest[1] ?? '', 10);
        if (Number.isFinite(number)) {
          if (rest.length === 2 && method === 'GET') {
            getPull(ctx, owner, name, number);
            return true;
          }
          if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
            listPullFiles(ctx, owner, name, number);
            return true;
          }
          if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
            mergePull(ctx, owner, name, number);
            return true;
          }
        }
        sendMessage(ctx, 405, 'Method not allowed');
        return true;
      }
    }
  }
  return false;
}
