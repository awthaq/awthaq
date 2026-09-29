---
ID: "PIL-007"
Title: "Expiry is checked before the secret, and the error tag leaks expiry state"
Level: low
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:483"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-007 — Expiry is checked before the secret, and the error tag leaks expiry state

`LOW` · `security` · `core` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **resolved**

## Summary

verify looks up the row by id and checks absolute/idle expiry before ever hashing the presented secret. A caller holding only the id half (it is in the cookie; ids end up in logs and analytics) receives a distinguishable SessionExpired — including a live 'when does this die' oracle — versus SessionNotFound for a nonexistent id, without ever proving knowledge of the secret. It also means a valid secret on an expired session and a wrong secret take different code paths. The uniform-response discipline this repo applies everywhere else (OAuth callback collapses every failure into one shape; bad-secret correctly reuses the no-such-session message) is not applied here.

## Evidence

Source: `packages/core/src/Sessions.ts:483`

```
if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
  return yield* Effect.fail(
    new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
```

## Recommended fix

Hash and constant-time-compare the presented secret first; only then evaluate expiry, and consider collapsing SessionExpired into SessionNotFound (or at least dropping the tag distinction at the HTTP boundary) so the middleware cannot become someone's session-state oracle.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session fundamentals
- Full dossier: [`pilcrow`](../../.reports/pilcrow/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-verify-hardening`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:786`. Fix: Prove the secret before any row-state branch: hash first, look up, constant-time compare (against a dummy hash on miss), and only then evaluate tombstone/expiry; reuse detection must require a matching secret. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** `Sessions.verify` now proves the presented secret before any row-state branch, in both layers (`packages/core/src/Sessions.ts`). The secret is hashed up front; an unknown id compares against a fixed dummy hash (same SHA-256 + constant-time work); a known id with a wrong secret fails the uniform `SessionNotFound` *before* the RRS-003 tombstone/reuse branch and before expiry. Consequences: forging `<supersededId>.<anything>` no longer revokes the victim's live family or publishes a false `auth.session.reuse` (the more serious defect this validation found — re-rate of this finding to **high** is warranted); an id-only caller can no longer distinguish `SessionExpired` from `SessionNotFound`; replaying the *full* pre-supersede token still triggers reuse detection (regression-guarded). Spec: BEH-EA-056 gains a "proof precedes state" paragraph (`spec/behaviors/07-sessions.md`).

TDD: `packages/core/test/Sessions.test.ts` adds, for both `layerMemory` and `layerSql`, 'PIL-007/RRS-003: presenting a superseded id with a WRONG secret revokes nothing and publishes no reuse event', 'PIL-007/BEH-EA-056: an expired row with a WRONG secret fails SessionNotFound, not SessionExpired', and 'replaying the full pre-supersede token still triggers reuse detection'. The first two were confirmed red before the fix (4 failures). Gates: `pnpm run typecheck`, `pnpm run test` (809 passed), `pnpm run test:bdd` (104 passed), `pnpm run spec:verify:strict` green. `pnpm lint` reports 8 pre-existing errors in untouched files (`ports/src/ClientAddress.ts` bigint literals, `core/test/HttpApiTypes.test.ts` barrel import) — not introduced here. Deferred: the `features/…/07-sessions.feature` HTTP-level scenario the dossier suggested (needs new step infrastructure and a REQ id); unit coverage in both layers stands in for it.

