---
ID: "ESS-011"
Title: "core/sql brand bridging is runtime-unchecked by design"
Level: info
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Models.ts:12"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-011 — core/sql brand bridging is runtime-unchecked by design

`INFO` · `architecture` · `sql` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **resolved**

## Summary

Core declares UserId/SessionId via Brand.nominal (type-level only) while sql declares Schema.brand schemas, and the boundary is bridged by unchecked nominal constructors (e.g. Users.UserId(row.userId) in PasskeyCredentials.ts:207, Password.ts:341). This is sound today — both sides are plain strings at runtime and the comment explains why — but the guarantee is comment-enforced: if either side ever gains a format refinement, the constructors keep silently accepting anything and the documented compatibility silently becomes false. Relatedly, AdminApi.ListQuery hand-writes its optionality type next to its schema instead of deriving it, a smaller instance of the same type-drift risk.

## Evidence

Source: `packages/sql/src/Models.ts:12`

```
structurally compatible (a `Brand<Keys>`'s uniqueness comes from the
```

## Recommended fix

Add a type-level test asserting sql's branded schema types are assignable to core's nominal brands (an Expect<Equal<...>> like client/test already uses), so a future refinement on either side fails compilation at the bridge instead of silently passing.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `sql-repository-hygiene`. Duplicate of `MA-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/Models.ts:11`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MA-008-michael-arnaldi` — closed by its fix (see that issue's Resolved comment).
