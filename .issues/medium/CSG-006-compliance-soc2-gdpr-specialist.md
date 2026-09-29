---
ID: "CSG-006"
Title: "Core PII columns are plaintext at rest with no documented encryption boundary"
Level: medium
Category: "compliance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Models.ts:116"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-006 — Core PII columns are plaintext at rest with no documented encryption boundary

`MEDIUM` · `compliance` · `sql` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **resolved**

## Summary

Only accounts.accessToken/refreshToken are encrypted at rest (AES-256-GCM with row+column AAD, Repositories.ts:158-162); users.email, users.name, sessions.ipAddress, sessions.userAgent, and organization_invitation.email are stored as plaintext - UsersRepositoryLive depends only on SqlClient, not on the Encryption port (Repositories.ts:76). Secrets are handled correctly (session secretHash, verification valueHash, password hashes are all hash-only and Model.Sensitive), so this is about direct database-level access to identifiable data. The deployer-facing docs never state that application-level encryption stops at the OAuth token columns, making at-rest protection an undocumented assumption.

## Evidence

Source: `packages/sql/src/Models.ts:116`

```
  ipAddress: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
```

## Recommended fix

Document the encryption boundary as an explicit deployer responsibility (full-disk/database encryption requirement), and consider application-level encryption for email (deterministic, to preserve lower(email) lookups) and IP addresses.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-docs-operations`. Evidence at HEAD ec065a7: `packages/sql/src/Models.ts:142`. Fix: Document the encryption boundary now. Depending on the decision, add opt-in application-level encryption for the non-lookup PII columns (ipAddress, userAgent, users.metadata) through the existing Encryption port, with row AAD. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option B per plan; user may revisit. Documented boundary: packages/sql/README.md 'Encryption at rest' (accounts tokens app-encrypted; password/session/verification secrets hash-only; everything else relies on deployer disk/DB encryption and TLS) + BEH-EA-034 paragraph. Opt-in PII encryption: Repositories.SessionsRepositoryEncryptedLive (sessions.ipAddress/userAgent, AAD session:<id>:<field>) and UsersRepositoryEncryptedLive (users.metadata, AAD user:<id>:metadata), reusing Encryption, the SMS-002 degrade-to-null-and-log policy and the KRS-002 lazy re-encryption (AccountsRepositoryConfig.reencryptOnRead). Deviation from the dossier's wording, in line with the type-system-first preference: the opt-in is choosing the encrypted layer (Encryption is then in the Layer's requirements, checked by the compiler) rather than a runtime SqlPiiEncryption Reference that would force Encryption on every deployment. Legacy plaintext rows stay readable and are sealed on read (shape test Encryption.looksLikeEnvelope, new additive export in @awthaq/ports); an envelope-shaped value that fails authentication reads as null, never plaintext. Tests packages/sql/test/PiiEncryption.test.ts (raw columns are ciphertext, plaintext through insert/findById/listByUser/touch/reauthenticate/update/findByEmail/verifyEmail, AAD binding, legacy sealing, null stays null). Option C (blind-index email) deferred as planned.
