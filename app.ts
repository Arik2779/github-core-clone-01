// The HTTP server: body reading, bearer auth (every route except /healthz),
// and the router for the REST, GraphQL, MCP and git surfaces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleReceivePack, handleInfoRefs, handleUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import type { Ctx } from './http.ts';
import { isAuthed, notFound, sendJson, unauthorized } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function splitSegments(pathname: string): string[] {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      segments.push(raw);
    }
  }
  return segments;
}

function readBody(req: IncomingMessage): Promise<Buffer<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks) as Buffer<ArrayBuffer>));
    req.on('error', reject);
  });
}

function route(ctx: Ctx): void {
  const { segments, req } = ctx;
  const method = req.method ?? 'GET';

  // Health: the only route that does not need the bearer token.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  if (!isAuthed(ctx)) {
    unauthorized(ctx);
    return;
  }

  // MCP (JSON-RPC 2.0).
  if (segments.length === 1 && segments[0] === 'mcp') {
    handleMcp(ctx);
    return;
  }

  // GraphQL.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(ctx, 405, { message: 'Method not allowed' });
      return;
    }
    handleGraphQL(ctx);
    return;
  }

  // REST v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (handleRest(ctx)) return;
    notFound(ctx, 'Not Found');
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/<info/refs|git-upload-pack|git-receive-pack>
  if (segments.length >= 3) {
    const repoSegment = segments[1]!;
    if (repoSegment.endsWith('.git')) {
      const owner = segments[0]!;
      const name = repoSegment.slice(0, -'.git'.length);
      const tail = segments.slice(2).join('/');
      if (tail === 'info/refs' && method === 'GET') {
        handleInfoRefs(ctx, owner, name);
        return;
      }
      if (tail === 'git-upload-pack' && method === 'POST') {
        handleUploadPack(ctx, owner, name);
        return;
      }
      if (tail === 'git-receive-pack' && method === 'POST') {
        handleReceivePack(ctx, owner, name);
        return;
      }
    }
  }

  notFound(ctx, 'Not Found');
}

export function createForgeServer(store: Store, token: string): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const run = async (): Promise<void> => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      } catch {
        url = new URL('/', 'http://localhost');
      }
      const needsBody =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
      let body: Buffer = Buffer.alloc(0);
      if (needsBody) {
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(413, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': store.nextRequestId() });
          res.end(JSON.stringify({ message: 'Request body too large' }));
          return;
        }
      }
      const ctx: Ctx = { store, token, req, res, url, segments: splitSegments(url.pathname), body };
      try {
        route(ctx);
      } catch (error) {
        // A handler must never kill the process; answer a JSON 500.
        if (!res.headersSent) {
          res.writeHead(500, {
            'Content-Type': 'application/json',
            'X-GitHub-Request-Id': store.nextRequestId(),
          });
          res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Internal error' }));
        } else {
          res.end();
        }
      }
    };
    void run();
  });
  return server;
}
