# makefun-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ayonclaw/makefun-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ayonclaw/makefun-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one process: git smart HTTP, REST v3, GraphQL v4 and MCP, served from
one in-memory store. No UI, no outside service, no `git` binary and no dependency at run time.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9bsf1q6a&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Surfaces

| Surface | What it serves |
| --- | --- |
| git smart HTTP | `GET /{owner}/{repo}.git/info/refs`, `POST .../git-upload-pack`, `POST .../git-receive-pack` — protocol v2 (ls-refs and fetch) with the v0 fallback, shallow fetches, annotated tags, per-ref push reports |
| REST v3 | `/api/v3/...`: repositories, branches, commits, contents, issues, comments, labels, pull requests, changed files and merges |
| GraphQL v4 | `POST /api/graphql`: `viewer`, `repository`, `node(id:)`, `__type` introspection, cursor pagination, operation batching and the create/close/comment/merge mutations |
| MCP | `POST /mcp`: JSON-RPC 2.0 over the Streamable HTTP transport, both the `2026-07-28` era (`server/discover`) and the `initialize` handshake era, with eleven tools |

Everything is served from one store: a repository, an issue or a pull request created over MCP is the
same object REST reads, with the same id. Every GitHub-shaped view (global node ids, `viewerPermission`,
`mergeable`, changed-file statistics) is derived from that store, never from a canned answer.

## Lifecycle

`main.ts` is the entry <-> env contract, unchanged from the kit's starter: bind an ephemeral port,
`POST $MAKEFUN_ENV_URL/register {"port": N}`, poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`,
then exit 0.

## License

MIT. See `LICENSE`.
