---
ID: "CSG-001"
Title: "Erasure cascade covers only core tables; plugin-owned PII survives account deletion"
Level: high
Category: "compliance"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Account.ts:76"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-001 — Erasure cascade covers only core tables; plugin-owned PII survives account deletion

`HIGH` · `compliance` · `server` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **ready-for-agent**

## Summary

The self-service DELETE /user flow erases exactly users, accounts and sessions. Everything else survives: passkey_credential rows (the passkey service offers only per-credential removeCredential with a last-credential refusal, never a bulk user purge), organization_membership rows, and organization_invitation rows that store the subject's plaintext email and are only status-transitioned, never deleted. The three calls also run without a transaction boundary (repositories deliberately never open one and this handler opens none), so a mid-cascade failure leaves a partially erased subject. Under GDPR Art. 17 this is an incomplete erasure with identifiable personal data left in at least three tables.

## Evidence

Source: `packages/server/src/Account.ts:76`

```
        yield* accounts.deleteAllByUser(userId);
        yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
        yield* users
```

## Recommended fix

Fire a BeforeUserDelete hook point from this handler, add deleteAllByUser operations to PasskeyCredentials and to organization membership/invitation records, and wrap the whole cascade in a single SqlClient transaction.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-007` — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll](low/CSG-007-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, low)_`
- [`DRS-002` — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables](high/DRS-002-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`SSMS-002` — Zero FK constraints and the shipped whole-user cascade runs without a transaction](medium/SSMS-002-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`
- [`SEA-001` — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade](medium/SEA-001-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, medium)_`
- [`TS-004` — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port](medium/TS-004-tim-smart.md) `_(tim-smart, medium)_`
- [`TRBS-008` — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll](low/TRBS-008-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, low)_`
- [`WPS-001` — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user](high/WPS-001-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/server/src/Account.ts:73-85`'s `deleteUser` calls only `accounts.deleteAllByUser`, `sessions.revokeOthers(userId, SessionId(""))`, and `users.delete`, with no transaction wrapper. A repo-wide grep for `deleteAllByUser` finds it implemented only for `Accounts` (`packages/core/src/Accounts.ts:116,280,409`) and `Sessions` (`packages/core/src/Sessions.ts:567`) — no equivalent exists for passkey credentials or organization membership/invitation, so those rows are never touched by this handler. Adding parallel `deleteAllByUser` methods (following the existing `Accounts`/`Sessions` pattern) plus a transaction wrapper is mechanical; it does not require the not-yet-existing `BeforeUserDelete` hook point (see CSG-002) to fix the core gap. Status → ready-for-agent.

**Partial progress (2026-09-19):** `Account.deleteUser`'s three-call cascade (`accounts.deleteAllByUser`/`sessions.revokeOthers`/`users.delete`) now runs inside one `SqlTransaction.withTransaction` (`layerNoop` for in-memory compositions, a real transaction over `SqlClient` otherwise) — closes the "non-transactional, partial-erasure-on-failure" half of this finding. The concrete, exploitable security consequence of the orphaned-passkey-credential gap this finding also names is independently closed: see WPS-001 (`Passkey.authenticateVerify` now rejects authentication for a deleted user's surviving credential, checked at auth time).

**Still open, not resolved:** actual erasure of plugin-owned PII (passkey credentials, organization membership/invitations, admin impersonation records, verification tokens) does not happen — `@awthaq/server`'s `Account.ts` cannot reach into an optional plugin's own tables without a real dependency-inversion mechanism, and this repo's existing `HookPoint.ts` module (the natural mechanism, per this finding's own recommended fix) turns out to be architecturally unsuited for that job as currently built: `HookPoint.veto<Self>()(id, schema)` backs its registry with per-class-instance closures that freeze permanently after the first `.run()` call (BEH-EA-024), meaning a concrete hook point declared once in library source (as `BeforeUserDelete` would need to be, to be tappable by an independently-composed plugin like `@awthaq/passkey`) cannot support different compositions wanting different tap sets — every composition in one process would collide on the same frozen registry. `HookPoint.ts`'s own header already documents that no concrete hook point has been wired into a real flow yet for exactly this class of reason, and `Auth.ts`'s header separately documents that `AuthCore` (the fixed session/account/etc. tuple a hook point's per-composition instantiation would naturally hang off) does not exist yet (MW-002). Closing this finding's full GDPR-completeness ask needs that groundwork first, not a mechanical per-plugin `deleteAllByUser` addition — flagging for whoever picks up MW-002/CSG-002 next rather than working around it here. Status unchanged: ready-for-agent.
