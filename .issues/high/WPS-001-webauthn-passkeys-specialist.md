---
ID: "WPS-001"
Title: "Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user"
Level: high
Category: "security"
Status: resolved
Package: "server"
Source: "packages/server/src/Account.ts:76"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-001 — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user

`HIGH` · `security` · `server` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **resolved**

## Summary

The self-service delete cascade erases account links, sessions, and the user row, but never touches passkey_credential (PasskeyCredentials' shape has no per-user bulk delete at all, packages/passkey/src/PasskeyCredentials.ts:57-86). authenticateVerify binds solely on credentials.findById (packages/passkey/src/Passkey.ts:550) and never consults Accounts, so the orphaned credential still passes cryptographic verification; Sessions.issue then inserts a session row for the dead userId without any user-existence check (packages/core/src/Sessions.ts:449-456) — the shipped DDL has no FK from sessions to users (packages/sql/src/CoreMigrations.ts:112-127) — and PrincipalResolverLive fabricates a UserPrincipal purely from session.userId (packages/server/src/Authentication.ts:46-50). Net effect: account deletion does not end authentication for whoever holds that passkey; a ghost principal for a nonexistent user walks the API. Every other credential type is protected because its linkage (accounts row, password hash) is deleted.

## Evidence

Source: `packages/server/src/Account.ts:76`

```
yield* accounts.deleteAllByUser(userId);
yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
yield* users
```

## Recommended fix

Add deleteAllByUser to PasskeyCredentials (both layers), invoke it from the account-delete flow alongside accounts.deleteAllByUser, and defend in depth: reject authentication/principal resolution when users.findById misses (either in Sessions.issue or in PrincipalResolverLive).

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-001` — Erasure cascade covers only core tables; plugin-owned PII survives account deletion](high/CSG-001-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-007` — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll](low/CSG-007-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, low)_`
- [`DRS-002` — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables](high/DRS-002-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`SSMS-002` — Zero FK constraints and the shipped whole-user cascade runs without a transaction](medium/SSMS-002-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`
- [`SEA-001` — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade](medium/SEA-001-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, medium)_`
- [`TS-004` — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port](medium/TS-004-tim-smart.md) `_(tim-smart, medium)_`
- [`TRBS-008` — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll](low/TRBS-008-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `Account.ts:76` matches the evidence exactly; `deleteUser` (`packages/server/src/Account.ts:73-85`) calls only `accounts.deleteAllByUser`, `sessions.revokeOthers`, and `users.delete`. `PasskeyCredentialsShape` (`packages/passkey/src/PasskeyCredentials.ts:57-90`) has only a single-credential `delete(id, userId)`, no bulk method. `authenticateVerify` binds solely on `credentials.findById` (`Passkey.ts:550`) and issues a session via `sessions.issue({ userId: stored.userId })` (`Passkey.ts:599`) with no `Users` lookup anywhere in `Sessions.ts`; `PrincipalResolverLive` (`Authentication.ts:43-50`) fabricates the principal purely from `session.userId`; `CoreMigrations.ts:112-127` confirms no FK on `sessions.userId`. Full claim chain verified. Fix (add `deleteAllByUser` to `PasskeyCredentials`, wire into the delete flow) mirrors the existing `accounts.deleteAllByUser` pattern — mechanical. Status → ready-for-agent.

**Resolved (2026-09-19):** `Passkey.authenticateVerify` now checks `Users.findById(stored.userId)` right before minting a session, failing uniform `Api.InvalidCredentials` (matching BEH-EA-136's existing collapse) when the credential's own user no longer exists — closing the exact chain this finding traced (orphaned credential -> cryptographic pass -> `Sessions.issue` with no existence check -> a ghost `UserPrincipal` walking the API), applied as defense-in-depth at authentication time rather than depending on erasure completeness. Added a regression test (register a credential, delete the user, attempt to authenticate with the still-live credential) confirmed red against the pre-fix code via a temporary revert before landing. Considered and rejected a cross-plugin `BeforeUserDelete` hook-point cascade (this repo's own `HookPoint.ts` module) as the primary fix: that module's registry is a frozen-once-run singleton per class instance, architecturally unsuited to per-composition wiring until `Auth.ts`'s `AuthCore`/session-account fragmentation (MW-002) resolves — a real, separately-tracked blocker, not a shortcut taken here. See CSG-001/DRS-002 for the transactional-cascade half of this cluster (also addressed) and the still-open plugin-data-erasure gap. Full `@awthaq/passkey` suite (51 tests) and monorepo typecheck pass. Status → resolved.
