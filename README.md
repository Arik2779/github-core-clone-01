# github-core-clone-01

A GitHub-compatible git forge in a single Node program (stdlib only, no
dependencies, no model calls): smart HTTP git transport (v2 + v0), REST API v3,
GraphQL v4, and an MCP endpoint over JSON-RPC 2.0. It is the entry for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http` and its own modules only, and the trial has no package manager and
no internet.

The entry reads `MAKEFUN_ENV_URL` (the env's origin), `MAKEFUN_SHOP_TOKEN`
(the bearer token it accepts) and `MAKEFUN_TRIAL_NOW` (the trial's fixed now,
an ISO instant or epoch milliseconds — every timestamp the forge emits comes
from it, never from the wall clock, so a replay leaves the same state).

## The lifecycle (main.ts)

1. Bind an ephemeral port (`listen(0)`). Never bind 8080: that is the env's port.
2. Register: `POST $MAKEFUN_ENV_URL/register` with `{"port": N}`.
3. Wait for done: poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`.
4. Close the server and exit 0.

## The surface

| Surface | Route | What it does |
| --- | --- | --- |
| Git | `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` | v2 advertisement + ls-refs + fetch (with shallow/deepen), v0 fallback, push with report-status |
| REST v3 | `/api/v3/...` | repos, refs, branches, commits, contents, labels, issues, comments, pull requests, merges |
| GraphQL v4 | `/api/graphql` | viewer, repository, node, issue/pull-request reads, five mutations, `__type` introspection, batching |
| MCP | `/mcp` | `server/discover` (2026-07-28) + legacy `initialize`, `tools/list`, seven tools |
| Health | `/healthz` | `200 {"ok": true}` (no auth) |

Every reply is `application/json` (git transport excluded) and carries a
non-empty `X-GitHub-Request-Id`. Every route except `/healthz` requires
`Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` and answers 401 without it. A
repo under another owner is 404, never 403.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll /done, exit 0).
- `app.ts` — the HTTP server, body reading, bearer auth, router.
- `store.ts` — the in-memory store: repos, git objects, refs, issues, pulls, labels,
  comments; every surface reads and writes through it, so a repo created over MCP
  reads back over `/api/v3` and a commit pushed over git is visible everywhere.
- `gitcore.ts` — the pure git object model: SHA-1 oids, commit/tree/tag codecs,
  pkt-line and sideband framing, packfiles (plain objects plus OFS/REF deltas).
- `git.ts` — the smart HTTP handlers: advertisements, ls-refs, fetch (v2 and v0),
  shallow/deepen selection, receive-pack with fast-forward checks.
- `rest.ts` — the REST v3 handlers.
- `graphql.ts` — a small GraphQL parser and executor.
- `mcp.ts` — the MCP handler and the seven tools.
- `http.ts` — the request context and shared response helpers.
- `util.ts` — trial-now parsing, opaque global ids, base64, a line diff.

## Determinism

The forge is a pure function of its requests and `MAKEFUN_TRIAL_NOW`: timestamps,
request ids and object ids are all derived from the trial now or from counters,
never from `Date.now()` or `Math.random()`. A replayed trial therefore exports
the same state byte for byte.

## License

MIT. See LICENSE.
