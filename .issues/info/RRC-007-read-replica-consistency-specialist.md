---
ID: "RRC-007"
Title: "Verification write path is replica-friendly by construction: single-statement issue/consume with RETURNING carrying all needed state"
Level: info
Category: "architecture"
Status: wontfix
Package: "sql"
Source: "packages/sql/src/Repositories.ts:570"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-007 — Verification write path is replica-friendly by construction: single-statement issue/consume with RETURNING carrying all needed state

`INFO` · `architecture` · `sql` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **wontfix**

## Summary

issue is one atomic INSERT..ON CONFLICT..RETURNING upsert (lines 548-560) and consume is one conditional UPDATE..RETURNING whose returned row already carries the payload — no read-after-write statement exists anywhere on the token path itself, so the verification flow has no replication window to close. The consume result travels back in the same statement that consumed the token, which is exactly the discipline (single-statement state transition, results carried not re-read) every other flow in this audit should copy; it is also why the plugin-level transactional gaps in RRC-002 are the only remaining consume-side consistency exposure.

## Evidence

Source: `packages/sql/src/Repositories.ts:570`

```
        UPDATE verification_tokens
        SET "consumedAt" = ${request.now}
        WHERE identifier = ${request.identifier}
```

## Recommended fix

Preserve and codify this pattern: new flows should return post-write state via RETURNING rather than re-reading, keeping the token path free of write-then-read windows regardless of future routing.

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

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `read-replica-routing`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:684`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/05-sql.md`.

**Wontfix (2026-09-29):** Positive observation, no defect. Nothing to change.
