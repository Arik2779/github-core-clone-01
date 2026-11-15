// GraphQL over POST /api/graphql. A small parser (selections, aliases, variables,
// input objects, lists, inline fragments, and __type introspection) plus resolvers
// for the documents the conformance suite sends: viewer, repository, node, issue
// and pull-request reads, and the five mutations. Unknown fields answer 200 with
// an errors array naming the field, never a 500.

import type { Ctx } from './http.ts';
import { badRequest, parseJsonBody, sendJson } from './http.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { VIEWER } from './store.ts';
import { b64decodeText, b64encodeText, decodeGlobalId, globalId } from './util.ts';

// ---- tokenizer --------------------------------------------------------------

type TokenKind =
  | 'name'
  | 'string'
  | 'int'
  | 'float'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'colon'
  | 'dollar'
  | 'spread'
  | 'equals'
  | 'bang'
  | 'at'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCTUATION: Record<string, TokenKind> = {
  '{': 'lbrace',
  '}': 'rbrace',
  '(': 'lparen',
  ')': 'rparen',
  '[': 'lbracket',
  ']': 'rbracket',
  ':': 'colon',
  '$': 'dollar',
  '=': 'equals',
  '!': 'bang',
  '@': 'at',
};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (char === '"') {
      // A block string (""") is never sent by the suite; a plain string is.
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (PUNCTUATION[char] !== undefined) {
      tokens.push({ kind: PUNCTUATION[char]!, value: char });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(char)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---- AST --------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface SelectionNode {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  typeCondition?: string;
  args?: ArgumentNode[];
  selections?: SelectionNode[];
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selections: SelectionNode[];
}

class Parser {
  private position = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private next(): Token {
    const token = this.tokens[this.position]!;
    this.position += 1;
    return token;
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`Expected ${what}, got ${token.kind} (${token.value})`);
    return token;
  }

  parseDocument(): OperationNode {
    const token = this.peek();
    if (token.kind === 'lbrace') {
      return { kind: 'query', variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind !== 'name' || (token.value !== 'query' && token.value !== 'mutation')) {
      throw new Error(`Expected an operation, got ${token.value}`);
    }
    const operation = this.next().value as 'query' | 'mutation';
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: OperationNode['variables'] = [];
    if (this.peek().kind === 'lparen') {
      this.next();
      while (this.peek().kind !== 'rparen') {
        this.expect('dollar', '$');
        const variableName = this.expect('name', 'a variable name').value;
        this.expect('colon', ':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'equals') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: variableName, defaultValue });
        if (this.peek().kind === 'rparen') break;
      }
      this.expect('rparen', ')');
    }
    return { kind: operation, name, variables, selections: this.parseSelectionSet() };
  }

  private parseType(): void {
    if (this.peek().kind === 'lbracket') {
      this.next();
      this.parseType();
      this.expect('rbracket', ']');
    } else {
      this.expect('name', 'a type name');
    }
    if (this.peek().kind === 'bang') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('lbrace', '{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== 'rbrace') {
      selections.push(this.parseSelection());
    }
    this.expect('rbrace', '}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      let typeCondition: string | undefined;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expect('name', 'a type name').value;
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.expect('name', 'a field name').value;
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'colon') {
      this.next();
      alias = first;
      name = this.expect('name', 'a field name').value;
    }
    let args: ArgumentNode[] | undefined;
    if (this.peek().kind === 'lparen') {
      args = this.parseArguments();
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'lbrace') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    this.expect('lparen', '(');
    const args: ArgumentNode[] = [];
    while (this.peek().kind !== 'rparen') {
      const name = this.expect('name', 'an argument name').value;
      this.expect('colon', ':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect('rparen', ')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'dollar':
        return { kind: 'variable', name: this.expect('name', 'a variable name').value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'lbracket': {
        const values: ValueNode[] = [];
        while (this.peek().kind !== 'rbracket') values.push(this.parseValue());
        this.expect('rbracket', ']');
        return { kind: 'list', values };
      }
      case 'lbrace': {
        const fields: { name: string; value: ValueNode }[] = [];
        while (this.peek().kind !== 'rbrace') {
          const name = this.expect('name', 'an object field').value;
          this.expect('colon', ':');
          fields.push({ name, value: this.parseValue() });
        }
        this.expect('rbrace', '}');
        return { kind: 'object', fields };
      }
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error(`Unexpected value token ${token.kind}`);
    }
  }
}

// ---- execution ---------------------------------------------------------------

type RuntimeObject = Record<string, unknown> & { __typename: string };

interface ExecutionContext {
  store: import('./store.ts').Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function evaluateValue(
  node: ValueNode,
  context: ExecutionContext,
): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = context.variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => evaluateValue(child, context));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, context);
      return out;
    }
  }
}

function argumentsOf(
  selection: SelectionNode,
  context: ExecutionContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const argument of selection.args ?? []) {
    out[argument.name] = evaluateValue(argument.value, context);
  }
  return out;
}

function responseName(selection: SelectionNode): string {
  return selection.alias ?? selection.name ?? '';
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE'],
};

function issueCursor(repo: Repo, issue: Issue): string {
  return b64encodeText(`IssueCursor:${repo.id}:${issue.number}`);
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = b64decodeText(cursor).toString('utf8');
    const match = /^IssueCursor:\d+:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function pageInfoFor(
  items: { cursor: string }[],
  total: number,
): RuntimeObject {
  const endCursor = items.length > 0 ? items[items.length - 1]!.cursor : null;
  const startCursor = items.length > 0 ? items[0]!.cursor : null;
  return {
    __typename: 'PageInfo',
    hasNextPage: items.length < total,
    hasPreviousPage: false,
    startCursor,
    endCursor,
  };
}

function toIssueObject(context: ExecutionContext, repo: Repo, issue: Issue): RuntimeObject {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: context.store.trialNowIso,
    updatedAt: context.store.trialNowIso,
  };
}

function toPullObject(context: ExecutionContext, repo: Repo, pull: Pull): RuntimeObject {
  const mergeable = context.store.hasMergeConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: context.store.trialNowIso,
  };
}

function toRepoObject(context: ExecutionContext, repo: Repo): RuntimeObject {
  const mainTip = repo.refs.get('refs/heads/main');
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    defaultBranchRef: mainTip
      ? { __typename: 'Ref', name: 'main', target: { __typename: 'Commit', oid: mainTip } }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.isPrivate,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    createdAt: context.store.trialNowIso,
  };
}

function connectionForIssues(
  context: ExecutionContext,
  repo: Repo,
  args: Record<string, unknown>,
): RuntimeObject {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? cursorNumber(args.after) : null;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  let issues = [...repo.issues.values()];
  if (states) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  issues.sort((a, b) => {
    const step = field === 'CREATED_AT' || field === 'UPDATED_AT'
      ? a.createdSeq - b.createdSeq
      : a.number - b.number;
    return direction === 'ASC' ? step : -step;
  });
  let items = issues;
  if (after !== null) {
    // The cursor names an issue number; in CREATED_AT DESC order the page after
    // it holds the issues created earlier (a smaller number).
    items = direction === 'ASC' ? items.filter((issue) => issue.number > after) : items.filter((issue) => issue.number < after);
  }
  const page = items.slice(0, first);
  const nodes = page.map((issue) => toIssueObject(context, repo, issue));
  return {
    __typename: 'IssueConnection',
    nodes,
    edges: nodes.map((node) => ({ __typename: 'IssueEdge', node, cursor: issueCursor(repo, (node._issue as Issue)) })),
    pageInfo: pageInfoFor(nodes.map((node) => ({ cursor: issueCursor(repo, node._issue as Issue) })), items.length),
    totalCount: items.length,
  };
}

function connectionForPulls(
  context: ExecutionContext,
  repo: Repo,
  args: Record<string, unknown>,
): RuntimeObject {
  const first = typeof args.first === 'number' ? args.first : 100;
  const pulls = [...repo.pulls.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  const page = pulls.slice(0, first);
  const nodes = page.map((pull) => toPullObject(context, repo, pull));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    edges: nodes.map((node) => ({ __typename: 'PullRequestEdge', node, cursor: b64encodeText(`PullRequestCursor:${repo.id}:${node.number}`) })),
    pageInfo: pageInfoFor(nodes.map((node) => ({ cursor: b64encodeText(`PullRequestCursor:${repo.id}:${node.number}`) })), pulls.length),
    totalCount: pulls.length,
  };
}

function connectionForFiles(
  context: ExecutionContext,
  repo: Repo,
  pull: Pull,
  args: Record<string, unknown>,
): RuntimeObject {
  const first = typeof args.first === 'number' ? args.first : 100;
  const baseTree = context.store.treeOf(repo, pull.baseSha);
  const headTree = context.store.treeOf(repo, pull.headSha);
  const files = baseTree && headTree ? context.store.treeDiffFiles(repo, baseTree, headTree) : [];
  const page = files.slice(0, first);
  const nodes = page.map((file) => ({ __typename: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }));
  return {
    __typename: 'PullRequestFileConnection',
    nodes,
    edges: nodes.map((node) => ({ __typename: 'PullRequestFileEdge', node, cursor: b64encodeText(`FileCursor:${node.path}`) })),
    pageInfo: pageInfoFor(nodes.map((node) => ({ cursor: b64encodeText(`FileCursor:${node.path}`) })), files.length),
    totalCount: files.length,
  };
}

function typeInfo(name: string): RuntimeObject | null {
  const knownFields = TYPE_FIELDS[name];
  if (!knownFields && name !== 'SearchType') return null;
  const isEnum = name === 'SearchType';
  return {
    __typename: '__Type',
    name,
    kind: isEnum ? 'ENUM' : 'OBJECT',
    description: null,
    fields: isEnum
      ? null
      : knownFields!.map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null, type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } })),
    enumValues: isEnum
      ? (TYPE_FIELDS.SearchType ?? []).map((value) => ({ __typename: '__EnumValue', name: value }))
      : null,
  };
}

function resolveField(
  context: ExecutionContext,
  parent: RuntimeObject,
  selection: SelectionNode,
): unknown {
  const typename = parent.__typename;
  const name = selection.name ?? '';
  const args = argumentsOf(selection, context);
  const childSelections = selection.selections ?? [];
  const wrap = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return value;
    if (!childSelections.length) return value;
    return executeSelections(context, value as RuntimeObject, childSelections);
  };

  if (typename === 'Query') {
    if (name === 'viewer') {
      return wrap({
        __typename: 'User',
        id: globalId('User', VIEWER.id),
        login: VIEWER.login,
        name: VIEWER.name,
        email: VIEWER.email,
        avatarUrl: VIEWER.avatarUrl,
      });
    }
    if (name === 'repository') {
      const repo = context.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return wrap(toRepoObject(context, repo));
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = context.store.listAllRepos().find((candidate) => String(candidate.id) === decoded.parts[0]);
        if (!repo) return null;
        return wrap(toRepoObject(context, repo));
      }
      if (decoded.kind === 'Issue') {
        const repo = context.store.listAllRepos().find((candidate) => String(candidate.id) === decoded.parts[0]);
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        if (!repo || !issue) return null;
        return wrap(toIssueObject(context, repo, issue));
      }
      if (decoded.kind === 'PullRequest') {
        const repo = context.store.listAllRepos().find((candidate) => String(candidate.id) === decoded.parts[0]);
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        if (!repo || !pull) return null;
        return wrap(toPullObject(context, repo, pull));
      }
      return null;
    }
    if (name === '__type') {
      const info = typeInfo(String(args.name ?? ''));
      if (!info) return null;
      return wrap(info);
    }
    if (name === '__schema') {
      return wrap({ __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' } });
    }
  }

  if (typename === 'Repository') {
    const repo = parent._repo as Repo;
    if (name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      if (!issue) return null;
      return wrap(toIssueObject(context, repo, issue));
    }
    if (name === 'issues') return wrap(connectionForIssues(context, repo, args));
    if (name === 'pullRequests') return wrap(connectionForPulls(context, repo, args));
    if (name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      if (!pull) return null;
      return wrap(toPullObject(context, repo, pull));
    }
    if (name === 'owner') {
      return wrap({
        __typename: 'User',
        id: globalId('User', repo.owner === VIEWER.login ? VIEWER.id : repo.id),
        login: repo.owner,
        name: repo.owner,
        email: '',
        avatarUrl: '',
      });
    }
    if (name === 'defaultBranchRef') {
      const ref = parent.defaultBranchRef;
      if (!ref) return null;
      return wrap(ref as RuntimeObject);
    }
    if (['id', 'databaseId', 'name', 'nameWithOwner', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'url', 'createdAt'].includes(name)) {
      return parent[name];
    }
  }

  if (typename === 'Issue') {
    if (name === 'author') {
      return wrap({
        __typename: 'User',
        id: globalId('User', VIEWER.id),
        login: (parent._issue as Issue).userLogin,
        name: '',
        email: '',
        avatarUrl: '',
      });
    }
    if (['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt'].includes(name)) {
      return parent[name];
    }
  }

  if (typename === 'PullRequest') {
    if (name === 'files') {
      return wrap(connectionForFiles(context, parent._repo as Repo, parent._pull as Pull, args));
    }
    if (['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'url', 'createdAt'].includes(name)) {
      return parent[name];
    }
  }

  if (typename === '__Type') {
    if (name === 'fields') {
      const fields = (parent.fields ?? null) as RuntimeObject[] | null;
      if (!fields) return null;
      return wrapFields(context, fields, childSelections);
    }
    if (name === 'enumValues') {
      const values = (parent.enumValues ?? null) as RuntimeObject[] | null;
      if (!values) return null;
      return wrapFields(context, values, childSelections);
    }
    if (['name', 'kind', 'description'].includes(name)) return parent[name];
  }

  if (typename === 'CreateIssuePayload' || typename === 'CloseIssuePayload' || typename === 'CreatePullRequestPayload' || typename === 'MergePullRequestPayload') {
    if (name === 'issue' || name === 'pullRequest') {
      const value = parent[name];
      if (!value) return null;
      return wrap(value as RuntimeObject);
    }
  }

  if (typename === 'AddCommentPayload') {
    if (name === 'commentEdge') {
      const edge = parent.commentEdge as RuntimeObject;
      if (!edge) return null;
      return wrap(edge);
    }
  }

  if (typename === 'IssueCommentEdge' || typename === 'PullRequestFileEdge' || typename === 'IssueEdge' || typename === 'PullRequestEdge') {
    if (name === 'node') {
      const node = parent.node as RuntimeObject;
      if (!node) return null;
      return wrap(node);
    }
    if (name === 'cursor') return parent.cursor;
  }

  if (typename === 'IssueConnection' || typename === 'PullRequestConnection' || typename === 'PullRequestFileConnection') {
    if (name === 'nodes') {
      const nodes = parent.nodes as RuntimeObject[];
      return nodes.map((node) => wrap(node));
    }
    if (name === 'edges') {
      const edges = parent.edges as RuntimeObject[];
      return edges.map((edge) => wrap(edge));
    }
    if (name === 'pageInfo') {
      const pageInfo = parent.pageInfo as RuntimeObject;
      return wrap(pageInfo);
    }
    if (name === 'totalCount') return parent.totalCount;
  }

  if (typename === 'PageInfo') {
    if (['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(name)) {
      return parent[name];
    }
  }

  if (typename === 'IssueComment') {
    if (['id', 'body'].includes(name)) return parent[name];
  }

  if (typename === 'PullRequestFile') {
    if (['path', 'additions', 'deletions', 'changeType'].includes(name)) return parent[name];
  }

  if (typename === 'Ref') {
    if (name === 'name') return parent.name;
    if (name === 'target') return wrap((parent.target ?? { __typename: 'Commit', oid: '' }) as RuntimeObject);
  }

  if (typename === 'Commit') {
    if (name === 'oid') return parent.oid;
  }

  if (typename === 'User') {
    if (['id', 'login', 'name', 'email', 'avatarUrl'].includes(name)) return parent[name];
  }

  if (typename === '__Field' || typename === '__EnumValue') {
    if (['name', 'description'].includes(name)) return parent[name];
    if (name === 'type') return wrap((parent.type ?? null) as RuntimeObject);
  }

  if (typename === '__Schema') {
    if (name === 'queryType' || name === 'mutationType') return wrap(parent[name] as RuntimeObject);
  }

  // Unknown field: a GraphQL error naming it, data null for that field.
  context.errors.push({ message: `Cannot query field "${name}" on type "${typename}".` });
  return null;
}

/** Execute a list of fields on a non-null object value. */
function wrapFields(
  context: ExecutionContext,
  fields: RuntimeObject[],
  selections: SelectionNode[],
): unknown[] {
  return fields.map((field) => executeSelections(context, field, selections));
}

function executeSelections(
  context: ExecutionContext,
  parent: RuntimeObject,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      // An inline fragment applies when the condition matches the parent type
      // (or is absent).
      if (!selection.typeCondition || selection.typeCondition === parent.__typename) {
        const nested = executeSelections(context, parent, selection.selections ?? []);
        for (const [key, value] of Object.entries(nested)) out[key] = value;
      }
      continue;
    }
    const name = responseName(selection);
    out[name] = resolveField(context, parent, selection);
  }
  return out;
}

// ---- mutations ---------------------------------------------------------------

function repoByGlobalId(context: ExecutionContext, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const repoId = Number(decoded.parts[0]);
  for (const repo of context.store.listAllRepos()) {
    if (repo.id === repoId) return repo;
  }
  // A repository can live under any owner; scan everything the store holds.
  return null;
}

function executeMutation(
  context: ExecutionContext,
  operation: OperationNode,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') {
      const nested = executeSelections(context, { __typename: 'Mutation' }, selection.selections ?? []);
      for (const [key, value] of Object.entries(nested)) out[key] = value;
      continue;
    }
    const name = responseName(selection);
    const args = argumentsOf(selection, context);
    const input = (args.input ?? {}) as Record<string, unknown>;

    if (selection.name === 'createIssue') {
      const repo = repoByGlobalId(context, String(input.repositoryId ?? ''));
      if (!repo) {
        context.errors.push({ message: 'Repository not found' });
        out[name] = { issue: null };
        continue;
      }
      const result = context.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in result) {
        context.errors.push({ message: result.error });
        out[name] = { issue: null };
        continue;
      }
      const issue = toIssueObject(context, repo, result);
      out[name] = executeSelections(context, { __typename: 'CreateIssuePayload', issue }, selection.selections ?? []);
      continue;
    }

    if (selection.name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded?.kind === 'Issue') {
        for (const repo of context.store.listAllRepos()) {
          if (repo.id !== Number(decoded.parts[0])) continue;
          const issue = repo.issues.get(Number(decoded.parts[1]));
          if (issue) found = { repo, issue };
        }
      }
      if (!found) {
        context.errors.push({ message: 'Issue not found' });
        out[name] = { issue: null };
        continue;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = context.store.trialNowIso;
      const issue = toIssueObject(context, found.repo, found.issue);
      out[name] = executeSelections(context, { __typename: 'CloseIssuePayload', issue }, selection.selections ?? []);
      continue;
    }

    if (selection.name === 'createPullRequest') {
      const repo = repoByGlobalId(context, String(input.repositoryId ?? ''));
      if (!repo) {
        context.errors.push({ message: 'Repository not found' });
        out[name] = { pullRequest: null };
        continue;
      }
      const result = context.store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in result) {
        context.errors.push({ message: result.error });
        out[name] = { pullRequest: null };
        continue;
      }
      const pull = toPullObject(context, repo, result);
      out[name] = executeSelections(context, { __typename: 'CreatePullRequestPayload', pullRequest: pull }, selection.selections ?? []);
      continue;
    }

    if (selection.name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      let found: { repo: Repo; pull: Pull } | null = null;
      if (decoded?.kind === 'PullRequest') {
        for (const repo of context.store.listAllRepos()) {
          if (repo.id !== Number(decoded.parts[0])) continue;
          const pull = repo.pulls.get(Number(decoded.parts[1]));
          if (pull) found = { repo, pull };
        }
      }
      if (!found) {
        context.errors.push({ message: 'Pull request not found' });
        out[name] = { pullRequest: null };
        continue;
      }
      const result = context.store.mergePull(found.repo, found.pull);
      if (!result.ok) {
        context.errors.push({ message: result.error });
        out[name] = { pullRequest: null };
        continue;
      }
      const pull = toPullObject(context, found.repo, found.pull);
      out[name] = executeSelections(context, { __typename: 'MergePullRequestPayload', pullRequest: pull }, selection.selections ?? []);
      continue;
    }

    if (selection.name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded?.kind === 'Issue') {
        for (const repo of context.store.listAllRepos()) {
          if (repo.id !== Number(decoded.parts[0])) continue;
          const issue = repo.issues.get(Number(decoded.parts[1]));
          if (issue) found = { repo, issue };
        }
      }
      if (!found) {
        context.errors.push({ message: 'Subject not found' });
        out[name] = { commentEdge: null };
        continue;
      }
      const comment = {
        id: context.store.nextCommentId(),
        issueNumber: found.issue.number,
        body: String(input.body ?? ''),
        userLogin: VIEWER.login,
        createdSeq: context.store.nextCommentSeq(),
      };
      found.repo.comments.set(comment.id, comment);
      const node: RuntimeObject = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', found.repo.id, comment.id),
        body: comment.body,
      };
      const edge: RuntimeObject = { __typename: 'IssueCommentEdge', node, cursor: b64encodeText(`CommentCursor:${found.repo.id}:${comment.id}`) };
      out[name] = executeSelections(context, { __typename: 'AddCommentPayload', commentEdge: edge }, selection.selections ?? []);
      continue;
    }

    context.errors.push({ message: `Cannot query field "${selection.name ?? ''}" on type "Mutation".` });
    out[name] = null;
  }
  return out;
}

// ---- handler -----------------------------------------------------------------

export function handleGraphQL(ctx: Ctx): void {
  const parsed = parseJsonBody(ctx);
  if (parsed.kind === 'malformed') {
    badRequest(ctx, 'Malformed JSON body');
    return;
  }
  if (parsed.kind === 'empty') {
    badRequest(ctx, 'Missing request body');
    return;
  }
  const operations: { query?: string; variables?: Record<string, unknown> }[] = Array.isArray(parsed.value)
    ? (parsed.value as { query?: string; variables?: Record<string, unknown> }[])
    : [{ query: (parsed.value as Record<string, unknown>).query as string | undefined, variables: (parsed.value as Record<string, unknown>).variables as Record<string, unknown> | undefined }];
  const answers: Record<string, unknown>[] = [];
  for (const operation of operations) {
    const query = typeof operation.query === 'string' ? operation.query : '';
    const variables = (operation.variables ?? {}) as Record<string, unknown>;
    try {
      const parser = new Parser(tokenize(query));
      const document = parser.parseDocument();
      const context: ExecutionContext = { store: ctx.store, variables, errors: [] };
      // Variable defaults.
      for (const variable of document.variables) {
        if (context.variables[variable.name] === undefined && variable.defaultValue !== undefined) {
          context.variables[variable.name] = evaluateValue(variable.defaultValue, context);
        }
      }
      let data: Record<string, unknown>;
      if (document.kind === 'mutation') {
        data = executeMutation(context, document);
      } else {
        data = executeSelections(context, { __typename: 'Query' }, document.selections);
      }
      const answer: Record<string, unknown> = { data };
      if (context.errors.length > 0) answer.errors = context.errors;
      answers.push(answer);
    } catch (error) {
      answers.push({
        data: null,
        errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }],
      });
    }
  }
  sendJson(ctx, 200, Array.isArray(parsed.value) ? answers : answers[0]!);
}
