// Request context and the response helpers every surface shares: JSON bodies are
// always application/json with a message on errors, unknown routes are 404 JSON,
// and every reply carries a non-empty X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  /** The bearer token this process accepts (MAKEFUN_SHOP_TOKEN). */
  token: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The request path split into decoded segments. */
  segments: string[];
  /** The raw request body, already read (null for GET/HEAD). */
  body: Buffer;
}

export function requestIdHeader(ctx: Ctx): Record<string, string> {
  return { 'X-GitHub-Request-Id': ctx.store.nextRequestId() };
}

/** The bearer token on this request, or null. */
export function bearerToken(ctx: Ctx): string | null {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1]! : null;
}

/** True when the request presented the right bearer token. */
export function isAuthed(ctx: Ctx): boolean {
  return ctx.token !== '' && bearerToken(ctx) === ctx.token;
}

export function sendBuffer(
  ctx: Ctx,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  ctx.res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    ...requestIdHeader(ctx),
    ...extra,
  });
  ctx.res.end(body);
}

export function sendJson(
  ctx: Ctx,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  // A 204 carries no body at all.
  if (status === 204) {
    ctx.res.writeHead(204, { ...requestIdHeader(ctx), ...extra });
    ctx.res.end();
    return;
  }
  const text = JSON.stringify(body);
  sendBuffer(ctx, status, Buffer.from(text, 'utf8'), 'application/json; charset=utf-8', extra);
}

export function sendText(
  ctx: Ctx,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
  extra: Record<string, string> = {},
): void {
  sendBuffer(ctx, status, Buffer.from(body, 'utf8'), contentType, extra);
}

export function sendMessage(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function unauthorized(ctx: Ctx, message = 'Bad credentials'): void {
  sendMessage(ctx, 401, message);
}

export function notFound(ctx: Ctx, message = 'Not Found'): void {
  sendMessage(ctx, 404, message);
}

export function badRequest(ctx: Ctx, message = 'Bad Request'): void {
  sendMessage(ctx, 400, message);
}

export function unprocessable(ctx: Ctx, message: string): void {
  sendMessage(ctx, 422, message);
}

export function forbidden(ctx: Ctx, message = 'Forbidden'): void {
  sendMessage(ctx, 403, message);
}

export type JsonObject = Record<string, unknown>;

export type ParsedBody =
  | { kind: 'empty' }
  | { kind: 'malformed' }
  | { kind: 'value'; value: unknown };

/** Parse the request body as JSON, distinguishing an empty body from a malformed one. */
export function parseJsonBody(ctx: Ctx): ParsedBody {
  if (ctx.body.length === 0) return { kind: 'empty' };
  try {
    return { kind: 'value', value: JSON.parse(ctx.body.toString('utf8')) as unknown };
  } catch {
    return { kind: 'malformed' };
  }
}

/**
 * Parse the body as a JSON object. An empty body yields {} (mirrors the suite's
 * clients, which sometimes POST with no body). A malformed body yields null.
 */
export function parseJsonObject(ctx: Ctx): JsonObject | null {
  const parsed = parseJsonBody(ctx);
  if (parsed.kind === 'empty') return {};
  if (parsed.kind === 'malformed') return null;
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return null;
  }
  return parsed.value as JsonObject;
}

/** Safe string field of a JSON object. */
export function stringField(body: JsonObject | null, field: string): string {
  if (!body) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** Safe boolean field of a JSON object. */
export function booleanField(body: JsonObject | null, field: string, fallback = false): boolean {
  if (!body) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** Safe integer field of a JSON object. */
export function intField(body: JsonObject | null, field: string, fallback = 0): number {
  if (!body) return fallback;
  const value = body[field];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** Parse a query integer with a default. */
export function queryInt(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
