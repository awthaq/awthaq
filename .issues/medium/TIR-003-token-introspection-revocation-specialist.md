---
ID: "TIR-003"
Title: "verifyLive consults page 1 of a paginated list - valid sessions beyond 200 rows false-negative"
Level: medium
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:383"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-003 — verifyLive consults page 1 of a paginated list - valid sessions beyond 200 rows false-negative

`MEDIUM` · `correctness` · `sql` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **resolved**

## Summary

verifyLive resolves liveness via sessions.list(sub) (packages/jwt/src/Jwt.ts:286), whose SQL layer fetches only the first page: listByUser(userId, undefined, LIST_PAGE_SIZE) with LIST_PAGE_SIZE = 200 (packages/core/src/Sessions.ts:418,570), ordered createdAt ASC - i.e. the 200 oldest rows. A user with more than 200 concurrent sessions has their recent sessions (the JWT's own sid, typically the newest) outside page 1, so rows.some(...) finds nothing and a perfectly valid token fails with 'session no longer live' - a self-inflicted denial of service. The memory layer's unbounded list hides this in tests. The same oldest-first page shape also makes GET /session's current-session lookup fragile at scale.

## Evidence

Source: `packages/sql/src/Repositories.ts:383`

```
? sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
      ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
```

## Recommended fix

Stop routing a point query through a paginated device list: add Sessions.isLive(userId, sid) backed by findById-style SQL (WHERE "userId" = ... AND id = ...) in the SQL layer and a direct HashMap.get in the memory layer.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token revocation & introspection
- Full dossier: [`token-introspection-revocation-specialist`](../../.reports/token-introspection-revocation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-list-liveness-and-pagination`. Already fixed by commit 6629fd2. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:446`. Fix: Add a keyed ownership lookup and route every point query through it. Make `list` exhaustive instead of silently truncating at 200. (effort M). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New Sessions.findOwned(userId, id) (one keyed findById + ownership/tombstone/expiry via the shared isLiveAt) in both layers; isLive is now findOwned+isSome; all four point-lookup call sites switched (server Session.ts current, passkey Passkey.ts requireFreshSession, qadi Resolvers.ts reauthHandler; revoke uses revokeOwned per GC-005). layerSql.list drains every page. grep: no production code calls sessions.list just to find one id. Tests as under ESS-005 (250-session layerSql test, server listless-Sessions tests, core findOwned test).
