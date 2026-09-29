---
ID: "MTI-006"
Title: "Admin impersonation is structurally tenant-blind: the gate predicate never sees the target"
Level: high
Category: "security"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:42"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-006 — Admin impersonation is structurally tenant-blind: the gate predicate never sees the target

`HIGH` · `security` · `admin` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

canImpersonate receives only the admin's own identity-only subject (subjectOf at Admin.ts:69-70 — 'id only, no roles, no permissions'); targetUserId is checked solely for self/nested cases (207-212) before an unrestricted session is issued for any user in any tenant (223-229). forceStop and list are gated by the same caller-only predicate and operate globally across all tenants (268-302). A multi-tenant host therefore has no way to express 'org A's admins may only impersonate org A's users' through this plugin: the predicate's signature cannot see the target, and admin exposes no veto hook (contrast organization's 20+ Before* hook points). The fail-closed default is good, but one misconfiguration like canImpersonate: () => true yields unconditional cross-tenant impersonation with an audit trail as the only compensation.

## Evidence

Source: `packages/admin/src/Admin.ts:42`

```
readonly canImpersonate: (subject: AuthSubject) => Effect.Effect<boolean>;
```

## Recommended fix

Extend canImpersonate to (adminSubject, targetSubject) (or add a BeforeImpersonate veto hook receiving both identities) so hosts can scope impersonation by tenant relationship; consider requiring a tenant-membership affinity check by default when the organization plugin is composed.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-006` — Impersonation cookie overwrite strands the admin's own live session with no handback](medium/APS-006-auth-pentest-specialist.md) `_(auth-pentest-specialist, medium)_`
- [`BAM-002` — All 11 plugin-owned tables have SQL layers but zero DDL](high/BAM-002-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-005` — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface](high/BAM-005-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-012` — Impersonation semantics differ from better-auth's cookie-swap model](info/BAM-012-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, info)_`
- [`CSS-003` — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie](medium/CSS-003-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`IDS-001` — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account](high/IDS-001-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, high)_`
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `Admin.ts:42` matches the evidence verbatim: `canImpersonate: (subject: AuthSubject) => Effect.Effect<boolean>`. All three call sites (`impersonate` ~line 213, `forceStop` ~line 268, `list` ~line 291) invoke `adminConfig.canImpersonate(subjectOf(caller))` — the admin's own identity only, never the target. `targetUserId` is checked only for self/nested cases before an unrestricted session is issued. Extending the predicate's signature to also receive the target is a well-scoped, if API-breaking, mechanical change. Status → ready-for-agent.

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `admin-impersonation-gate-target`. Duplicate of `IDS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:43`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `IDS-001-impersonation-delegation-specialist` — closed by its fix (see that issue's Resolved comment).
