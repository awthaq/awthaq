---
ID: "BAM-005"
Title: "Admin plugin is impersonation-only versus better-auth's 14-capability admin surface"
Level: high
Category: "api"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/Admin.ts:80"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-005 — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface

`HIGH` · `api` · `admin` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

AdminShape contains exactly four operations (impersonate, stopImpersonating, forceStop, list). better-auth's admin plugin ships createUser, listUsers, getUser, updateUser, setRole, banUser/unbanUser, deleteUser, setUserPassword, setUserEmail, listUserSessions, revokeUserSession plus the adminUserIds superuser bypass and banned-flag enforcement at sign-in (better-auth/06-authorization/02-admin-plugin.md). There is no banned field on User or any sign-in gate for one, and no per-user role storage to set-role into (roles are a static qadi graph config, see BAM-006). Teams whose production tooling depends on better-auth admin endpoints cannot migrate their admin flows at all.

## Evidence

Source: `packages/admin/src/Admin.ts:80`

```
readonly impersonate: (input: {
```

## Recommended fix

Scope the gap explicitly: either grow the admin plugin (user CRUD, session revocation reuse Sessions.revokeAll, a durable banned flag checked in the sign-in path) or document the qadi-based re-homing plan (bans as qadi deny-attributes, roles via the roles plugin) with what each migration step must build itself.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-006` — Impersonation cookie overwrite strands the admin's own live session with no handback](medium/APS-006-auth-pentest-specialist.md) `_(auth-pentest-specialist, medium)_`
- [`BAM-002` — All 11 plugin-owned tables have SQL layers but zero DDL](high/BAM-002-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-012` — Impersonation semantics differ from better-auth's cookie-swap model](info/BAM-012-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, info)_`
- [`CSS-003` — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie](medium/CSS-003-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`IDS-001` — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account](high/IDS-001-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, high)_`
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-007` — Both stop paths refuse to revoke when the audit row is missing or already ended](low/IDS-007-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/admin/src/Admin.ts:80` matches (`readonly impersonate: (input: {`), and `AdminShape` exposes exactly `impersonate`/`stopImpersonating`/`forceStop`/`list`; a grep for `banned`/`createUser`/`listUsers`/`setRole`/`banUser` across `packages/admin/src` and `packages/core/src` returns nothing. Deciding whether to grow the admin plugin's surface or formally scope better-auth admin parity out is a product decision. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Admin API surface expansion beyond impersonation](../../.scratch/resolve-ready-for-human-findings/issues/19-admin-api-surface-expansion.md) — Resolved via growing `packages/admin` with user CRUD, session administration, and a `banned` core-level gate (checked at `Sessions.issue`'s callers), following the existing fail-closed `canImpersonate` config pattern; `setRole` is explicitly scoped out as qadi's own concern per `ADR-EA-009` (flagged as a scope call, not an engineering inevitability). Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-surface-expansion`. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:368`. Fix: Implement ticket 19 §1: fail-closed per-capability predicates, user/session admin endpoints, and a core-level ban gate at every sign-in call site. (effort XL). Full dossier: `.plan/slices/10-passkey-admin.md`.

**Plan note (2026-09-29):** Left open by P05 after landing a coherent gate-green first slice (commit "Add fail-closed user and session administration to the admin surface (BAM-005 slice 1)"). Landed: AdminConfig.canManageUsers({ admin, target: Option<AuthSubject> }) (fail-closed; target-aware like canImpersonate, a deliberate improvement on the dossier's caller-only signature after IDS-001), Users.list keyset page (core memory + SQL via UsersRepository.listPage), admin endpoints listUsers/getUser/updateUser/listUserSessions/revokeUserSession/revokeUserSessions (impersonation sessions excluded and untouched), AdminActionDenied/AdminSessionNotFound, events auth.admin.actionDenied/userUpdated/sessionRevoked (+AuditLog actor mapping), spec BEH-EA-221..224 (NOTE for the orchestrator: new BEH ids 221-224 in spec/behaviors/27 - other programs assigning BEH-EA-221+ will collide; also REQ-EA-628..632 in features/). Remaining, and why: (1) banUser/unbanUser + canBanUsers + the core UserBanned sign-in gate at every Sessions.issue caller + revokeAll on ban - NOT started: the storage and the one shared sign-in gate belong to SCP-001 (P14: Users.status/setStatus/assertCanSignIn, same migration as the banned fields); once that lands the admin side is a small addition (predicate, two endpoints, an event, revokeAll). (2) deleteUser - needs the single shared erasure cascade (accounts, sessions, verification, BeforeUserDelete taps, transaction) that P11 will own; duplicating @awthaq/server Account.deleteUser's cascade here would fork it. (3) setUserEmail/setUserPassword - Users has no email-change operation (P14 identity model) and Password owns credential writes (P07); admin cannot depend on the password plugin stratum. (4) README statement that setRole is a qadi/application concern (ADR-EA-009) - to be written with the BAM-012 client-contract docs.

**Plan note (2026-09-29, P14):** ban slice landed in commit 4b63d9e, closing remainder (1) and (4) of the note above. Landed: `Users.setStatus` / `Users.assertCanSignIn` (core, SCP-001) consulted by password, passkey and oauth sign-in; `AdminConfig.canBanUsers` (fail-closed, target-aware like canManageUsers); `banUser` (`POST /admin/users/:userId/ban {reason?, until?}`: gate -> AdminSelfBanRefused -> existence -> `Users.setStatus('suspended')` -> `Sessions.revokeAll(userId, 'suspended')` -> `auth.admin.userBanned`) and `unbanUser` (`POST .../unban` -> `setStatus('active')` + `auth.admin.userUnbanned`); `SessionRevocationReason` gains `suspended`; AdminApi `UserDto` is now identity-aware (identity, image, status, statusReason, suspendedUntil); admin README documents the ban capability and states why there is no setRole (ADR-EA-009); spec BEH-EA-221/222/224 amended in place (no new BEH id). Tests: admin AdminUsers.test.ts (ban is fail-closed even with canManageUsers; a banned user is refused by the shared gate and every session is revoked while getUser/unbanUser still resolve them; timed ban lapses; self-ban refused; the gate sees the target) and AuthHttp.test.ts (real HTTP: own predicate, badly-formed `until` is a 400, the banned user's session cookie is dead, unban restores). STILL OPEN: (2) deleteUser — needs the single shared erasure cascade (accounts, sessions, verification, BeforeUserDelete taps, transaction) that P11 will own; (3) setUserEmail/setUserPassword — `Users.changeEmail` now exists as the primitive but an admin-set address must be verified by its owner and Password owns credential writes (P07); the tenant slice (EP-003) is unchanged. Known gap: a banned user's already-issued session is ended by `revokeAll` at ban time only; `Authentication.resolveSession` does not re-check status per request (opt in to `PrincipalResolverWithUserFactsLive` for per-request user facts).
