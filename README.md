# Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Bruskots/makefun-github-core-clone-03/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Bruskots/makefun-github-core-clone-03/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, built
only on the Node standard library. No dependencies, no git binary, no
database, no UI: the whole state lives in memory and is served over four
surfaces from one HTTP server.

## Surfaces

- **Git smart HTTP** — `/{owner}/{repo}.git`: `info/refs` plus
  `git-upload-pack` (protocol v2 with `ls-refs` and `fetch`, v0 fallback)
  and `git-receive-pack` (v0, `report-status`, `side-band-64k`,
  `delete-refs`). Packs are built and read by hand: SHA-1 objects,
  zlib streams, pkt-lines, shallow boundaries, fast-forward enforcement.
- **REST v3** — `/api/v3`: repositories, branches, commits, contents,
  labels, issues, comments and pull requests, including squash merge
  with three-way conflict detection.
- **GraphQL v4** — `/api/graphql`: the `viewer` / `repository` / `node`
  reads and the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, plus the `__type`
  introspection probes clients feature-detect with.
- **MCP** — `/mcp`: JSON-RPC 2.0 over Streamable HTTP, revision
  `2026-07-28` via `server/discover` (with the `initialize` handshake
  as a fallback), eight tools that act on the same store as REST.

## Running

```sh
node --experimental-strip-types main.ts
```

The process needs two environment variables:

- `MAKEFUN_ENV_URL` — the suite origin to register with and poll for done.
- `MAKEFUN_SHOP_TOKEN` — the bearer token every API call must carry.

It binds an ephemeral port (port 0), POSTs `{"port": <port>}` to
`$MAKEFUN_ENV_URL/register`, serves until `GET $MAKEFUN_ENV_URL/done`
answers `{"done": true}`, then exits 0. `GET /healthz` answers
`{"ok": true}` without authentication.

## Layout

- `main.ts` — the entrypoint: bind, register, poll for done, exit.
- `server.ts` — the HTTP server and all routing.
- `store.ts` — the in-memory forge: repositories, refs, objects,
  issues, pull requests, merges and the JSON shapes they are served as.
- `gitproto.ts` — the git wire: pkt-lines, object hashing, tree/commit
  parsing, packfiles, reachability and shallow fetch math.
- `graphql.ts` — a small GraphQL parser and executor for the v4
  documents the suite sends.
- `mcp.ts` — the MCP endpoint: discovery, handshake, tools/list and
  the eight tools.

## Notes

Everything is deterministic: commit timestamps come from a counter, not
the wall clock, and ids and numbers are assigned in creation order, so
two runs driven the same way reach the same state. Packs the forge sends
are never delta-compressed — every object travels whole — while packs it
receives may carry deltas, which are resolved on the way in.

Speed work in this revision: push numbering stops at commits that are
already numbered instead of re-walking the whole chain; a fetch only
walks the full wanted graph when the client actually sent haves; repeated
fetches of the same objects are answered from a per-repo cache; and
single-issue and single-repo reads are served from pre-serialized JSON
that is rebuilt only when the repository changes.
