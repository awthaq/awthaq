---
ID: "MA-008"
Title: "Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors"
Level: low
Category: "architecture"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Models.ts:11"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-008 — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors

`LOW` · `architecture` · `sql` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **ready-for-agent**

## Summary

Verified against the installed effect@4.0.0-rc.116 Brand.ts: Brand<Keys> is structural on the literal key string, so core's Brand.nominal<"UserId"> and sql's Schema.brand("UserId") really do unify — the claim checks out. But the two identities are still independent declarations with no compile-time link, and the bridge points all launder through the constructors (Sessions.ts:431 `SessionId(row.id)`), whose parameter is plain string — so if one side's key is ever renamed, every re-wrap site still compiles and the mismatch surfaces nowhere, defeating the nominal typing both packages went out of their way to establish. Four ids (UserId, AccountId, SessionId, VerificationTokenId) carry this latent duplicate today.

## Evidence

Source: `packages/sql/src/Models.ts:11`

```
// own `UserId`/`SessionId`/`AccountId`/`VerificationTokenId` — the two are
// structurally compatible (a `Brand<Keys>`'s uniqueness comes from the
// literal string key, not a runtime symbol), and it is core's eventual
```

## Recommended fix

Declare the branded id types once in the lowest stratum that both packages already share (@awthaq/ports, or a tiny @awthaq/ids) and have sql's schemas and core's constructors import the same declaration; the stratum rule ('a stratum depends only on strata below it') already permits it.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-repository-hygiene`. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:48`. Fix: Declare each id type once, in @awthaq/sql, the lower stratum core already imports. Core re-exports the type and keeps a nominal constructor over it, so a key rename on either side breaks every bridge at compile time. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
