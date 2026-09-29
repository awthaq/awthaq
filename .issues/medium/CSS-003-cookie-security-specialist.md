---
ID: "CSS-003"
Title: "stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie"
Level: medium
Category: "correctness"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:259"
Auditor: "cookie-security-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSS-003 — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie

`MEDIUM` · `correctness` · `admin` · reported by **Cookie Security Specialist** (`cookie-security-specialist`)

Status: **resolved**

## Summary

impersonate overwrites the browser's __Host-session with the impersonated target's token (Admin.ts:163-167) — the admin's own session row survives server-side (features 27-admin-impersonation.feature:73 even specifies 'the admin's own original session cookie still authenticates afterward'), but its token no longer exists in any browser jar. stopImpersonating then revokes the impersonated session and ends the episode without any Set-Cookie, so the admin's browser now holds a guaranteed-dead cookie and the user appears signed out even though a live admin session exists server-side. The cookie bridge — the only mechanism that could hand the original token back — is missing on both legs of the impersonation lifecycle.

## Evidence

Source: `packages/admin/src/Admin.ts:259`

```
yield* sessions.revoke(Sessions.SessionId(caller.sessionId)).pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.admin.impersonationStopped",
```

## Recommended fix

Have stopImpersonating re-mint (or return) the admin's own session cookie via securitySetCookie — e.g. issue a fresh superseding session for the caller with supersedes — and add a wire test that the stop response rotates __Host-session back to an admin session.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 58/100), domain: Cookie & Set-Cookie security
- Full dossier: [`cookie-security-specialist`](../../.reports/cookie-security-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-006` — Impersonation cookie overwrite strands the admin's own live session with no handback](medium/APS-006-auth-pentest-specialist.md) `_(auth-pentest-specialist, medium)_`
- [`BAM-002` — All 11 plugin-owned tables have SQL layers but zero DDL](high/BAM-002-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-005` — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface](high/BAM-005-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-012` — Impersonation semantics differ from better-auth's cookie-swap model](info/BAM-012-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, info)_`
- [`IDS-001` — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account](high/IDS-001-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, high)_`
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-007` — Both stop paths refuse to revoke when the audit row is missing or already ended](low/IDS-007-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `admin-impersonation-cookie-contract`. Duplicate of `APS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:164`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `APS-006-auth-pentest-specialist` — closed by its fix (see that issue's Resolved comment).
