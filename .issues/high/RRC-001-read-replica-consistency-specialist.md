---
ID: "RRC-001"
Title: "No replica-routing hooks, staleness classification, or read-your-writes guardrail exists anywhere in the persistence layer"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Repositories.ts:5"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-001 — No replica-routing hooks, staleness classification, or read-your-writes guardrail exists anywhere in the persistence layer

`HIGH` · `architecture` · `sql` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **ready-for-agent**

## Summary

A repo-wide search for replica/read-preference/primary-pinning/lag-routing vocabulary finds zero routing hits; every read and write in all five core repositories plus the organization plugin's record stores flows through one ambient SqlClient. Read-your-writes for login->verify, consume->account-read, and membership-write->qadi-read therefore holds today only as an architectural accident of single-client single-primary topology, not as a designed or documented guarantee. Because repositories never open transactions (BEH-EA-035), nothing technically prevents an operator from splitting reads to a Postgres replica — the standard scaling step — at which point every causal chain in the auth path silently loses its ordering guarantee, with no hook point, no per-query tolerance classification, and no documentation flagging the dependency.

## Evidence

Source: `packages/sql/src/Repositories.ts:5`

```
// Each repository is a `Context.Service` built with `SqlModel.makeRepository`
// over the ambient `SqlClient` (BEH-EA-035) — none opens its own
// transaction; the calling domain service (in `@awthaq/core`'s
```

## Recommended fix

Document the single-primary read-your-writes assumption in the repository stratum spec and each repository header; define a staleness-tolerance classification per repository method (session-credential reads and membership-decision reads = primary-pinned; listings = replica-eligible); expose a causal-token hook (e.g. Postgres LSN returned by writes, accepted as a minimum by reads) so read splitting can be made safe mechanically rather than by convention.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: replica consistency
- Full dossier: [`read-replica-consistency-specialist`](../../.reports/read-replica-consistency-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Decision (2026-09-19):** Resolved via [Read-replica consistency routing](../../.scratch/resolve-ready-for-human-findings/issues/28-read-replica-consistency-routing.md) — adds an opt-in, default-off `ReadRouting` service (`Context.Reference`-based replica client + fiber-scoped causal token) so listing/history reads can route to a replica while session/verification/membership reads stay pinned to the primary per ADR-EA-014, with no change to the ambient-`SqlClient` contract repositories already use. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/sql/src/Repositories.ts:5-11` matches the evidence exactly (the header comment placing the transaction boundary on the calling domain service), and a repo-wide grep for replica/read-preference/lag-routing vocabulary across `packages/` and `spec/` turns up nothing but unrelated mentions of "replica" in threat-model prose. Designing a staleness-tolerance classification and causal-token hook is an architecture decision requiring judgment, not a mechanical patch. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `read-replica-routing`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:5`. Fix: Implement ticket 28's decision: an opt-in, default-off `ReadRouting` module (a `ReplicaSqlClient` Context.Reference plus a fiber-scoped `CurrentCausalToken`), and a per-method staleness classification in which only display/history listings are replica-eligible. (effort XL). Full dossier: `.plan/slices/05-sql.md`.
