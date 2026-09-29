---
ID: "CSG-007"
Title: "deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll"
Level: low
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Account.ts:77"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-007 — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll

`LOW` · `correctness` · `server` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **resolved**

## Summary

The erasure flow uses revokeOthers with a sentinel empty SessionId to revoke everything, while Sessions.revokeAll exists precisely for 'revokes every session for userId, no exceptions' (Sessions.ts:193-194, added by upstream-hardening ticket 02). The trick is correct today (no real session id is empty and the comment documents it), but it silently depends on deleteAllForUserExcept's keep-comparison semantics; a future change that validates `keep` belongs to the user would break erasure completeness mid-cascade.

## Evidence

Source: `packages/server/src/Account.ts:77`

```
        yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
```

## Recommended fix

Call sessions.revokeAll(userId) - the API that already exists for exactly this semantics - and reserve sentinel-id tricks for flows that lack a dedicated primitive.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-001` — Erasure cascade covers only core tables; plugin-owned PII survives account deletion](high/CSG-001-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`DRS-002` — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables](high/DRS-002-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`SSMS-002` — Zero FK constraints and the shipped whole-user cascade runs without a transaction](medium/SSMS-002-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`
- [`SEA-001` — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade](medium/SEA-001-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, medium)_`
- [`TS-004` — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port](medium/TS-004-tim-smart.md) `_(tim-smart, medium)_`
- [`TRBS-008` — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll](low/TRBS-008-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, low)_`
- [`WPS-001` — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user](high/WPS-001-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `gdpr-erasure-export`. Already fixed by commit ec065a7. Evidence at HEAD ec065a7: `packages/server/src/Account.ts:112`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
