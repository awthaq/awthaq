---
ID: "DRS-002"
Title: "Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables"
Level: high
Category: "compliance"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Account.ts:76"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-002 — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables

`HIGH` · `compliance` · `server` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **ready-for-agent**

## Summary

deleteUser (:73-85) runs three independent service calls with no SqlTransaction wrapper: a failure between them strands a user row with no accounts/sessions, a partial-erasure state. Worse for residency, the cascade covers only accounts, sessions, and the user row — organization_invitation.email (third-party invitee addresses, packages/organization/src/InvitationRecords.ts:28), passkey_credential rows, organization_membership/team_membership, organization_active_context (orphaned sessionId key), admin_impersonation, and verification_tokens (identifier embeds the userId; payload may hold OAuth flow state) are all never cleaned. Erasure completeness — the predicate any DPO or residency auditor checks first — cannot be demonstrated from this code.

## Evidence

Source: `packages/server/src/Account.ts:76`

```
yield* accounts.deleteAllByUser(userId);
yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
yield* users
```

## Recommended fix

Wrap the cascade in the existing SqlTransaction port and route it through a domain-level deleteUser that every plugin can subscribe to (AuthEvents or a hook point), so each plugin erases its own rows for the userId; add a per-user data-export handler alongside it for access/portability requests.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-001` — Erasure cascade covers only core tables; plugin-owned PII survives account deletion](high/CSG-001-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-007` — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll](low/CSG-007-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, low)_`
- [`SSMS-002` — Zero FK constraints and the shipped whole-user cascade runs without a transaction](medium/SSMS-002-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`
- [`SEA-001` — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade](medium/SEA-001-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, medium)_`
- [`TS-004` — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port](medium/TS-004-tim-smart.md) `_(tim-smart, medium)_`
- [`TRBS-008` — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll](low/TRBS-008-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, low)_`
- [`WPS-001` — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user](high/WPS-001-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Data retention sweep & GDPR erasure cascade](../../.scratch/resolve-ready-for-human-findings/issues/30-data-retention-gdpr-erasure.md) — moves the erasure cascade into a `@awthaq/core` domain service (`Users.eraseAccount`) wrapped in the existing `SqlTransaction` port, and adds an `ErasureRegistry` (an ADR-EA-012-style dependency-ordered aggregating registry, not an observe-style hook) so plugins can register their own PII cleanup for the same transaction. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/server/src/Account.ts:76-78` matches the quoted three-call sequence verbatim, and the file imports no `SqlTransaction` (confirmed via grep). The cascade genuinely touches only accounts/sessions/users; org, passkey, admin-impersonation, and verification tables are untouched. Wrapping the existing three calls in `SqlTransaction` is mechanical, but the wider fix (a cross-plugin erasure hook point, since no such mechanism exists today) is an architecture decision. Status → ready-for-human.

**Partial progress (2026-09-19):** `Account.deleteUser`'s three-call cascade (`accounts.deleteAllByUser`/`sessions.revokeOthers`/`users.delete`) now runs inside one `SqlTransaction.withTransaction` (`layerNoop` for in-memory compositions, a real transaction over `SqlClient` otherwise) — closes the "non-transactional, partial-erasure-on-failure" half of this finding. The concrete, exploitable security consequence of the orphaned-passkey-credential gap this finding also names is independently closed: see WPS-001 (`Passkey.authenticateVerify` now rejects authentication for a deleted user's surviving credential, checked at auth time).

**Still open, not resolved:** actual erasure of plugin-owned PII (passkey credentials, organization membership/invitations, admin impersonation records, verification tokens) does not happen — `@awthaq/server`'s `Account.ts` cannot reach into an optional plugin's own tables without a real dependency-inversion mechanism, and this repo's existing `HookPoint.ts` module (the natural mechanism, per this finding's own recommended fix) turns out to be architecturally unsuited for that job as currently built: `HookPoint.veto<Self>()(id, schema)` backs its registry with per-class-instance closures that freeze permanently after the first `.run()` call (BEH-EA-024), meaning a concrete hook point declared once in library source (as `BeforeUserDelete` would need to be, to be tappable by an independently-composed plugin like `@awthaq/passkey`) cannot support different compositions wanting different tap sets — every composition in one process would collide on the same frozen registry. `HookPoint.ts`'s own header already documents that no concrete hook point has been wired into a real flow yet for exactly this class of reason, and `Auth.ts`'s header separately documents that `AuthCore` (the fixed session/account/etc. tuple a hook point's per-composition instantiation would naturally hang off) does not exist yet (MW-002). Closing this finding's full GDPR-completeness ask needs that groundwork first, not a mechanical per-plugin `deleteAllByUser` addition — flagging for whoever picks up MW-002/CSG-002 next rather than working around it here. Status unchanged: ready-for-agent.

**Partial progress (2026-09-20):** Duplicate source/evidence of [`CSG-001`](CSG-001-compliance-soc2-gdpr-specialist.md), which carries the full resolution detail. Summary: the blocker named above no longer holds (CSG-002 shipped `Hooks.BeforeUserDelete`, a real wired veto point); `@awthaq/passkey`'s new `Passkey.beforeUserDeleteErasure` and `@awthaq/organization`'s new `Organization.beforeUserDeleteErasure` (both separately-exported opt-in `Layer`s, not merged into each plugin's own `.layer` — the tap registry's freeze-after-first-run constraint makes that unsafe across a repeatedly-rebuilt test suite) now sweep `passkey_credential`/`organization_membership` respectively, mutation-verified. `Account.ts`'s own `sessions.revokeOthers(userId, SessionId(""))` sentinel also replaced with `sessions.revokeAll(userId)` (CSG-007/TRBS-008, bundled since the line was already being touched). Still open, deliberately scoped out: `organization_team_membership`/`organization_invitation` (same mechanism, not yet populated), `organization_active_context` (no `userId` column), `admin_impersonation` (audit-retention tension, a policy call not made here) — see CSG-001's own comment for the full reasoning on each. Status unchanged: ready-for-agent.
