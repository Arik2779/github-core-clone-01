// Model Context Protocol over POST /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Modern discovery (server/discover, 2026-07-28) plus the legacy initialize
// handshake; tools/list is a fixed constant (two calls must answer byte for
// byte) and the six tools act on the same store as REST and GraphQL.

import type { Ctx } from './http.ts';
import { parseJsonBody, sendJson, sendText } from './http.ts';
import type { Repo } from './store.ts';
import { VIEWER } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone-01', version: '1.0.0' };

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the new repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by squash.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
];

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function toolOk(structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  return typeof value === 'number' ? Math.trunc(value) : Number.NaN;
}

function getRepoOrError(
  ctx: Ctx,
  owner: string,
  repoName: string,
): { repo: Repo } | { error: string } {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
  return { repo };
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === '') return toolError('name is required');
      const owner = stringArg(args, 'owner') || VIEWER.login;
      if (ctx.store.hasRepo(owner, repoName)) {
        return toolError(`name already exists on this account`);
      }
      const description = stringArg(args, 'description');
      const isPrivate = args.private === true;
      const repo = ctx.store.createRepo(owner, repoName, description, isPrivate)!;
      return toolOk({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        url: `/api/v3/repos/${repo.owner}/${repo.name}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}`,
      });
    }
    case 'get_repo': {
      const found = getRepoOrError(ctx, stringArg(args, 'owner'), stringArg(args, 'repo'));
      if ('error' in found) return toolError(found.error);
      const repo = found.repo;
      return toolOk({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        url: `/api/v3/repos/${repo.owner}/${repo.name}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}`,
      });
    }
    case 'create_issue': {
      const title = stringArg(args, 'title');
      if (title === '') return toolError('title is required');
      const found = getRepoOrError(ctx, stringArg(args, 'owner'), stringArg(args, 'repo'));
      if ('error' in found) return toolError(found.error);
      const result = ctx.store.createIssue(found.repo, title, stringArg(args, 'body'), []);
      if ('error' in result) return toolError(result.error);
      return toolOk({
        id: result.id,
        number: result.number,
        title: result.title,
        body: result.body,
        state: result.state,
        url: `/api/v3/repos/${found.repo.owner}/${found.repo.name}/issues/${result.number}`,
        html_url: `https://github.com/${found.repo.owner}/${found.repo.name}/issues/${result.number}`,
      });
    }
    case 'list_issues': {
      const found = getRepoOrError(ctx, stringArg(args, 'owner'), stringArg(args, 'repo'));
      if ('error' in found) return toolError(found.error);
      const state = stringArg(args, 'state') || 'open';
      let issues = [...found.repo.issues.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const items = issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        state: issue.state,
      }));
      return toolOk({ issues: items, total_count: items.length });
    }
    case 'create_pull_request': {
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === '' || head === '' || base === '') {
        return toolError('title, head and base are required');
      }
      const found = getRepoOrError(ctx, stringArg(args, 'owner'), stringArg(args, 'repo'));
      if ('error' in found) return toolError(found.error);
      const result = ctx.store.createPull(found.repo, title, stringArg(args, 'body'), head, base);
      if ('error' in result) return toolError(result.error);
      return toolOk({
        id: result.id,
        number: result.number,
        title: result.title,
        body: result.body,
        state: result.state,
        head: result.headRef,
        base: result.baseRef,
        url: `/api/v3/repos/${found.repo.owner}/${found.repo.name}/pulls/${result.number}`,
        html_url: `https://github.com/${found.repo.owner}/${found.repo.name}/pull/${result.number}`,
      });
    }
    case 'merge_pull_request': {
      const found = getRepoOrError(ctx, stringArg(args, 'owner'), stringArg(args, 'repo'));
      if ('error' in found) return toolError(found.error);
      const number = numberArg(args, 'pull_number');
      if (!Number.isFinite(number)) return toolError('pull_number is required');
      const pull = found.repo.pulls.get(number);
      if (!pull) return toolError(`Pull request not found: ${number}`);
      const result = ctx.store.mergePull(found.repo, pull);
      if (!result.ok) return toolError(result.error);
      return toolOk({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        merged: true,
        merge_commit_sha: result.sha,
        url: `/api/v3/repos/${found.repo.owner}/${found.repo.name}/pulls/${pull.number}`,
      });
    }
    case 'get_issue': {
      const found = getRepoOrError(ctx, stringArg(args, 'owner'), stringArg(args, 'repo'));
      if ('error' in found) return toolError(found.error);
      const number = numberArg(args, 'issue_number');
      if (!Number.isFinite(number)) return toolError('issue_number is required');
      const issue = found.repo.issues.get(number);
      if (!issue) return toolError(`Issue not found: ${number}`);
      return toolOk({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: `/api/v3/repos/${found.repo.owner}/${found.repo.name}/issues/${issue.number}`,
      });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function missingRequired(tool: ToolDefinition, args: Record<string, unknown>): string | null {
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return required;
    }
  }
  return null;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function handleRequest(ctx: Ctx, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    const result: Record<string, unknown> = {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    };
    return rpcResult(id, result);
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const metaVersion = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
      : requested;
    return rpcResult(id, {
      protocolVersion: metaVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = ((params.arguments ?? {}) as Record<string, unknown>);
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return rpcError(id, -32601, `Method not found: ${name}`);
    }
    const missing = missingRequired(tool, args);
    if (missing !== null) {
      return rpcError(id, -32602, `Missing required argument: ${missing}`);
    }
    const result = callTool(ctx, name, args);
    if (result.isError) {
      return rpcResult(id, result);
    }
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(ctx: Ctx): void {
  if (ctx.req.method !== 'POST') {
    if (ctx.req.method === 'GET') {
      // A plain GET is not a JSON-RPC call; answer 406 rather than a body.
      sendText(ctx, 405, 'Method not allowed');
      return;
    }
    sendText(ctx, 405, 'Method not allowed');
    return;
  }
  const parsed = parseJsonBody(ctx);
  if (parsed.kind === 'malformed') {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed.kind === 'empty') {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const value = parsed.value;
  // A batch of requests: answer an array in the same order.
  if (Array.isArray(value)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      const request = entry as JsonRpcRequest;
      if (request.id === undefined) continue;
      const answer = handleRequest(ctx, request);
      if (answer) answers.push(answer);
    }
    sendJson(ctx, 200, answers);
    return;
  }
  if (value === null || typeof value !== 'object') {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = value as JsonRpcRequest;
  // A notification carries no id: acknowledge it and send nothing back.
  if (request.id === undefined) {
    sendText(ctx, 202, '');
    return;
  }
  const answer = handleRequest(ctx, request);
  if (answer) sendJson(ctx, 200, answer);
  else sendText(ctx, 202, '');
}
