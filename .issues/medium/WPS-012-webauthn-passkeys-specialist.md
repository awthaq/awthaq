---
ID: "WPS-012"
Title: "layerSql queries two tables whose CREATE TABLE exists only in test fixtures"
Level: medium
Category: "architecture"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:369"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-012 — layerSql queries two tables whose CREATE TABLE exists only in test fixtures

`MEDIUM` · `architecture` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **resolved**

## Summary

The plugin declares both tables and ChallengeStore.layerSql / PasskeyCredentials.layerSql issue real INSERT/SELECT/UPDATE/DELETE against them, but the only DDL in the repo is hand-written inside ChallengeStore.test.ts:29 and PasskeyCredentials.test.ts:23; CoreMigrations covers only the five core tables and no plugin populates the AuthPlugin migrations slot. A production deployment that selects the SQL backends this package advertises fails on the first ceremony. The single-use SQL design itself (atomic upsert + DELETE...RETURNING) is exactly right — it just cannot boot anywhere outside tests.

## Evidence

Source: `packages/passkey/src/Passkey.ts:369`

```
tables: ["passkey_credential", "passkey_challenge"],
```

## Recommended fix

Ship dual-dialect migrations for passkey_credential (id PK, userId index) and passkey_challenge (scope PK) through the existing AuthPlugin migrations mechanism, and add a test asserting every declared table has a migration.

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `passkey-docs`. Already fixed by commit 58ef46a. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:535`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Already fixed by BAM-002 (commit 58ef46a): Passkey.migrations ship the tables and ChallengeStore/PasskeyCredentials SQL tests run through them; extended here with four more migrations.
