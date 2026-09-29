---
ID: "BCR-009"
Title: "Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay"
Level: low
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Models.ts:165"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-009 — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay

`LOW` · `correctness` · `sql` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **resolved**

## Summary

Verification.issue requires a TTL and the schema makes expiresAt mandatory, while recovery codes conventionally do not expire (better-auth's do not; research/07 specifies no TTL). A plugin would have to invent an arbitrary far-future horizon; a user presenting an expired code years later gets the same TokenConsumed as a wrong code — correct as an anti-oracle, but a silent permanent loss of the recovery path with no warning channel (no low-remaining or near-expiry surface exists).

## Evidence

Source: `packages/sql/src/Models.ts:165`

```
  expiresAt: Schema.DateTimeUtcFromString.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
```

## Recommended fix

Give TwoFactorConfig an explicit code-set TTL default (e.g. 1-2 years) and surface remaining-count/expiry through a countLive operation so clients can warn; optionally make expiresAt nullable with documented never semantics rather than a magic horizon.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-003` — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows](high/BCR-003-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `two-factor-recovery-codes`. Evidence at HEAD ec065a7: `packages/sql/src/Models.ts:225`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/05-sql.md`.

**Resolved (2026-09-29):** Verified moot against the current package: recovery codes are not `Verification` tokens. They live in `two_factor_recovery_code` (packages/two-factor/src/TwoFactorStore.ts: `codeHash`, `usedAt`, no `expiresAt`), so nothing needs a far-future horizon, codes never expire, and a spent or wrong code fails the ordinary way. The remaining count the finding wanted for a low-codes warning is already surfaced (`remainingRecoveryCodes` on the status/enable responses, `auth.twoFactor.recoveryCodeUsed { remaining }`, `countUnused`). Recorded in BEH-EA-264 (spec/behaviors/31-two-factor.md). No code change.
