---
ID: "NAM-007"
Title: "Existing Auth.js sessions cannot be migrated — forced global re-authentication"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Models.ts:101"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-007 — Existing Auth.js sessions cannot be migrated — forced global re-authentication

`MEDIUM` · `dx` · `sql` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **ready-for-agent**

## Summary

Auth.js database sessions persist the plaintext `sessionToken`; effect-auth persists only SHA-256 of a secret half and verifies the presented `id.secret` token by re-digesting and constant-time comparing (Sessions.ts:31-53). That is the right security trade, but it makes the sessions table non-convertible: an ETL cannot transform a plaintext Auth.js token into a valid secretHash without knowing each secret's preimage. Every migrated user is logged out at cutover — acceptable for most apps, but a planning requirement (maintenance window, user communication, CSRF cookie rollover) that nothing in the repo acknowledges. The same applies to Credentials-provider passwords: the shipped hashers verify only their own argon2id/scrypt PHC format (PasswordHasher.ts:42-46 'Known non-goal'), so Auth.js bcrypt hashes need a custom dual-format PasswordHasher Layer plus the plugin's rehashOnLogin (Password.ts:552) to phase in.

## Evidence

Source: `packages/sql/src/Models.ts:101`

```
// BEH-EA-049/050: only `SHA-256(secret)` is ever persisted — `secretHash`
// itself is `Model.Sensitive` on top of that, so a leaked JSON variant
```

## Recommended fix

Publish a migration runbook: users/accounts ETL (Auth.js `provider`+`providerAccountId` → `providerId`+`subject`+`issuer=''`), sessions deliberately dropped with forced re-login, and a dual-format PasswordHasher recipe (verify legacy format, needsRehash→true, rehashOnLogin upgrades) for credentials-provider hashes.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `sql-docs-operations`. Already fixed by commit 19a3e00. Evidence at HEAD ec065a7: `packages/ports/src/LegacySessionBridge.ts:3`. Fix: Publish an Auth.js migration runbook built on the now-existing ports. No new package unless demand appears. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
