---
ID: "IDS-001"
Title: "canImpersonate never sees the target, so no host can refuse impersonating a more privileged account"
Level: high
Category: "security"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/Admin.ts:214"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-001 — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account

`HIGH` · `security` · `admin` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **ready-for-agent**

## Summary

The gate is invoked with a bare identity-only subject of the caller (Admin.ts:69-70 builds it from `principal.ref.id` alone; the signature at Admin.ts:42 accepts exactly one AuthSubject). targetUserId is in scope at the call site but is never passed. This is the classic impersonation flaw: any deployment that enables impersonation - even one whose gate is 'only user with role superadmin may impersonate' - allows that admin to impersonate ANY other user id, including fellow superadmins, org owners, or billing admins, because no code path anywhere compares caller privilege against target privilege. The layering rationale documented in the module header explains why the subject is identity-only, but it does not explain why the target is withheld from the predicate; eligibility-of-target is not expressible by hosts at all.

## Evidence

Source: `packages/admin/src/Admin.ts:214`

```
const allowed = yield* adminConfig.canImpersonate(subjectOf(caller));
```

## Recommended fix

Widen the gate to `canImpersonate(callerSubject, targetSubject | targetUserId)` (or add a second `canImpersonateTarget` knob) so hosts can compare privilege/tenant, defaulting to deny on target-evaluation failure; add a BDD scenario 'an admin cannot impersonate an account more privileged than themselves'.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 71/100), domain: Impersonation & Delegation
- Full dossier: [`impersonation-delegation-specialist`](../../.reports/impersonation-delegation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-006` — Impersonation cookie overwrite strands the admin's own live session with no handback](medium/APS-006-auth-pentest-specialist.md) `_(auth-pentest-specialist, medium)_`
- [`BAM-002` — All 11 plugin-owned tables have SQL layers but zero DDL](high/BAM-002-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-005` — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface](high/BAM-005-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-012` — Impersonation semantics differ from better-auth's cookie-swap model](info/BAM-012-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, info)_`
- [`CSS-003` — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie](medium/CSS-003-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-007` — Both stop paths refuse to revoke when the audit row is missing or already ended](low/IDS-007-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/admin/src/Admin.ts:214` (`const allowed = yield* adminConfig.canImpersonate(subjectOf(caller));`) matches verbatim, and reading `impersonate` in full (lines 195-230) confirms `targetUserId` is in scope but never passed to `canImpersonate`, nor compared against caller privilege anywhere else in the file. `subjectOf` (line 137-138) confirms the identity-only, caller-only subject shape. Widening the gate's signature to accept the target is a well-scoped, unambiguous mechanical change. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-impersonation-gate-target`. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:43`. Fix: Make the impersonation gate target-aware: `canImpersonate({ admin, target })` for impersonate, and episode-aware predicates for forceStop/list, all fail-closed. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`.
