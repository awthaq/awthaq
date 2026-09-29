---
ID: "ESS-010"
Title: "Documented latent decode asymmetry in VerificationToken.payload"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Models.ts:155"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-010 — Documented latent decode asymmetry in VerificationToken.payload

`LOW` · `correctness` · `sql` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **ready-for-agent**

## Summary

The payload column stores missing payloads as encoded literal "null" and decodes both omitted and explicit null back to undefined (Verification.ts:255 normalizes null to undefined), while the memory layer round-trips null verbatim — an acknowledged, currently-unreachable behavioral divergence between the two Layer implementations of the same service interface. Honest documentation is good, but a documented latent decode-compat divergence in the same column that OAuth flow state (codeVerifier, nonce) travels through is one new caller away from a real bug.

## Evidence

Source: `packages/sql/src/Models.ts:155`

```
* `payload: null` is indistinguishable from omission once round-tripped
```

## Recommended fix

Make the divergence unreachable rather than documented: either reject explicit null at the Verification.issue boundary with a typed error, or make layerMemory normalize null to undefined to match the SQL encoding.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-store-hygiene`. Evidence at HEAD ec065a7: `packages/core/src/Verification.ts:170`. Fix: Make the divergence unreachable: layerMemory normalizes explicit `null` to `undefined` at issue, matching the SQL encoding. Enforce it with a shared two-layer contract test. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
