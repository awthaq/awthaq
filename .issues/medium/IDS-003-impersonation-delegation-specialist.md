---
ID: "IDS-003"
Title: "Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/Admin.ts:223"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-003 — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target

`MEDIUM` · `correctness` · `admin` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **ready-for-agent**

## Summary

`impersonate` never checks that targetUserId exists: Admin.make yields Sessions, AuthEvents, ImpersonationRecords, and AdminConfig but never consults Users (Admin.ts:195-198), and sessions.issue inserts the row without a user foreign key in either layer (core Sessions memory layer inserts `userId: input.userId` directly; the SQL Session model defines userId with no reference constraint). Any syntactically valid id string yields a live dual-identity session, a durable audit row, and an impersonationStarted event for a user who does not exist - polluting the audit trail and, worse, silently creating target-side session state for ids that were never registered (typo support tickets become phantom sessions). Spec BEH-EA-218 even speaks of 'an unknown target user' as an ordinary validation failure, but no code implements it.

## Evidence

Source: `packages/admin/src/Admin.ts:223`

```
const issued = yield* sessions
          .issue({
            userId: targetUserId,
```

## Recommended fix

Validate target existence before the gate (Users.findByEmail-style lookup or a Sessions.issue existence check) and fail with a typed error; add a BDD scenario for an unknown target id.

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
- [`IDS-001` — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account](high/IDS-001-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, high)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-007` — Both stop paths refuse to revoke when the audit row is missing or already ended](low/IDS-007-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-impersonation-gate-target`. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:287`. Fix: Refuse impersonation of a nonexistent target with a typed 404, after the gate, and tighten the path-param schemas. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
