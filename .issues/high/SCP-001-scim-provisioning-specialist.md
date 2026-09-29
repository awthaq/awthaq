---
ID: "SCP-001"
Title: "No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Models.ts:40"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-001 — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists

`HIGH` · `architecture` · `sql` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **ready-for-agent**

## Summary

The User model (and UserRecord in packages/core/src/Users.ts:28-36) carries exactly id/email/emailVerified/name/createdAt/updatedAt — no active, status, or suspended column, and UsersShape's only removal path is Users.delete (packages/core/src/Users.ts:67), a destructive cascade (Accounts.deleteAllByUser). SCIM's operative case per spec/models/12-scim.md:19 is offboarding, expressed as active:false PATCH — a suspension that preserves the account and rejects sign-in while retaining the audit trail. Today a directory deactivation could only be modeled as account destruction (data loss, no re-provisioning tombstone) or ignored entirely, and spec/models/12-scim.md:57 itself concedes there is 'no answer to how a SCIM-deactivated user interacts with already-issued sessions'.

## Evidence

Source: `packages/sql/src/Models.ts:40`

```
export class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert(UserId),
  email: Schema.String,
```

## Recommended fix

Before any SCIM work, add a suspendable user state (active/suspended column plus Users.setActive) and define the tombstone contract: SCIM deactivate (active:false) suspends and revokes sessions but never deletes; SCIM delete removes the link and records an external-id tombstone that blocks silent re-provisioning — mirroring the better-auth reference invariant in better-auth/04-oauth-and-federation/06-scim.md:269 that deactivation is NEVER a delete.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — Models.ts:40-41 and Users.ts's `UserRecord` carry no `active`/`status`/`suspended` field, and Users.ts:67's `delete` is the only removal path (a destructive cascade). Defining the suspend-vs-delete tombstone contract is a product/architecture decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [UserRecord model extension (optional email, phone/anonymous identity, deactivation state)](../../.scratch/resolve-ready-for-human-findings/issues/09-userrecord-model-extension.md) — new `status: "active" | "suspended"` column and dedicated `Users.setStatus` operation (never a generic write path), composed with the existing `Sessions.revokeAll` at the caller site; SCIM-specific external-id tombstoning stays scoped to ticket 08's `packages/scim` rather than leaking into core. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `user-identity-lifecycle`. Evidence at HEAD ec065a7: `packages/sql/src/Models.ts:40`. Fix: Implement ticket 09's decision: `status: "active" | "suspended"` with a dedicated `Users.setStatus` (never a generic write), composed with `Sessions.revokeAll` at the caller. Co-design the sign-in gate and migration with ticket 19's `banned` fields (BAM-005) so there is one gate and one migration. (effort M). Full dossier: `.plan/slices/05-sql.md`.
