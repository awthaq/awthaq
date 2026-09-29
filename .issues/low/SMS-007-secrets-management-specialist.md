---
ID: "SMS-007"
Title: "Spec's model-level Redacted typing for provider tokens is not what shipped"
Level: low
Category: "docs"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Models.ts:94"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-007 — Spec's model-level Redacted typing for provider tokens is not what shipped

`LOW` · `docs` · `sql` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **resolved**

## Summary

spec/behaviors/05-persistence-stratum.md:48 (BEH-EA-034) sketches accessToken: Model.Sensitive(Schema.Redacted(Schema.String)), but the Account model carries plain strings; values become Redacted only inside Encryption.encrypt (packages/sql/src/Repositories.ts:187) and are unwrapped on the way out (Effect.map(Redacted.value), line 199). Practical exposure is unchanged - JSON exclusion via Model.Sensitive holds and disk bytes are ciphertext - but the glossary's claim that secrets 'are carried as Redacted throughout' is not literally true for account rows, and the drift will mislead doc-driven review and future model authors.

## Evidence

Source: `packages/sql/src/Models.ts:94`

```
accessToken: Model.Sensitive(Schema.NullOr(Schema.String)),
```

## Recommended fix

Either type the repository boundary in Redacted (tokens returned as Redacted<string>) or amend BEH-EA-034 and the glossary to state the real boundary: plaintext in model rows, ciphertext on disk, Redacted only at the encryption seam.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-encrypted-token-read-path`. Evidence at HEAD ec065a7: `spec/behaviors/05-persistence-stratum.md:45`. Fix: Amend the spec to match the real, deliberate boundary. Do not retype the repository: a `Schema.Redacted` encoded form cannot be bound as a SQL parameter (Models.ts:77-86), and core already re-wraps tokens as `Redacted` at the domain boundary (`ProviderTokenSet.accessToken: Redacted.Redacted<string>`, core Accounts.ts:85-87). (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Spec amended: spec/behaviors/05-persistence-stratum.md BEH-EA-034 illustration now Model.Sensitive(Schema.NullOr(Schema.String)) plus a paragraph on the deliberate plaintext-in-memory/ciphertext-on-disk/Redacted-at-seam boundary; spec/glossary.md Redacted entry qualified. spec:verify:strict passes.
