# Plan 26 baseline (ticket 01)

Tree: `main` @ `e8540343` (worktree branch `feat/request-context`), effect 4.1.2. Batch-2 plans 15 (`AuthHost`),
20 (`UserAgent`) and 21 (`SessionLifecycle`) have landed.

## §2.1 counts

| Measure | main@935d15ee (plan) | here |
|---|---:|---:|
| plugin source files importing `ClientAddress` | 10 | 10 |
| address resolutions in plugin handlers (`.resolve(request)`, `ClientAddress.facts/address`) | 24 | 31 |
| `"user-agent"` reads outside webhooks/web | 9 | 2 (`ports/src/ClientAddress.ts:70` in `facts`, `server/src/RequestContext.ts:85`) |
| `readonly ip?` on plugin interfaces | 32 | 33 |
| `readonly userAgent?` on plugin interfaces | 17 | 17 |
| `clientIp:` stamped outside core | 6 | 6 |
| `Key.ip` rules | 27 | 28 |
| opt-in machinery references | 9 | 9 |
| explicit request arguments in core interfaces | 3 | 4 |
| test/feature files that issue sessions in-process | 79 | 82 |
| ip/userAgent literals in tests | 199 | 212 |

## Suites

- `pnpm test`: 392 files passed, 5 skipped; 5208 tests passed, 1 expected fail, 17 skipped; 27 s.
- OpenAPI of `examples/memory-server` (`OpenApi.fromApi(built.api)`, sorted keys): `openapi-before.json` (252,753 bytes).
- Postgres (127.0.0.1:55499) was down when work started; CI runs `pnpm test:pg`.

## Phase 5 sweep list

Files that issue sessions in-process (82) or call a sign-in plugin service in-process (51): `sweep-sessions.txt`,
`sweep-plugins.txt`.
