---
ID: "EOTS-008"
Title: "Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets"
Level: medium
Category: "performance"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Repositories.ts:87"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-008 — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets

`MEDIUM` · `performance` · `sql` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **ready-for-agent**

## Summary

Repository operations built with `SqlModel.makeRepository` get named spans via spanPrefix (Users/Accounts/Sessions/VerificationTokens — the only span names awthaq contributes; verified upstream in effect@4.0.0-rc `SqlModel.js` `Effect.withSpan(`${options.spanPrefix}.insert`)`), and transactions get a generic `sql.transaction` span. But every hand-written statement — `findByEmail` (:87-91), `verifyEmail` (:93-99), and the equivalent custom queries for accounts/sessions/verification tokens — produces no span at all. The latency-sensitive lookups on the sign-in path (email lookup, credential-hash fetch) are precisely the untraced ones, inverting the tracing value: the operations you most want on a flame graph are invisible.

## Evidence

Source: `packages/sql/src/Repositories.ts:87`

```
const findByEmail = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: User,
        execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`,
```

## Recommended fix

Wrap each custom statement in `Effect.withSpan("Users.findByEmail", ...)` (or adopt a small helper mirroring makeRepository's naming) so every query in the sign-in path appears in a trace.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `sql-repository-hygiene`. Evidence at HEAD ec065a7: `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/sql/Statement.ts:1305`. Fix: Give every hand-written repository method a named span, matching SqlModel's `<spanPrefix>.<method>` convention, so a flame graph shows `Users.findByEmail > sql.execute` rather than an anonymous `sql.execute`. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
