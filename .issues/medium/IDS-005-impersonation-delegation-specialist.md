---
ID: "IDS-005"
Title: "Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token"
Level: medium
Category: "dx"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:163"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-005 — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token

`MEDIUM` · `dx` · `admin` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **resolved**

## Summary

The handler sets the impersonated token into the same `__Host-session` cookie (httpOnly, secure, sameSite=strict per Sessions.ts:124-129), destroying the browser's only copy of the admin's original token. BEH-EA-213/216's no-handback design assumes 'the caller is expected to already hold their own original session's token' - true for token-bearing clients, false for every cookie-based web client this same handler serves, so after stopImpersonating (which revokes the impersonated session and sets no cookie) a browser admin is fully signed out and must re-authenticate. The BDD scenario REQ-EA-385 ('the admin's own original session cookie still authenticates afterward') only passes because the test world retains the raw cookie string separately from the jar semantics a real browser applies.

## Evidence

Source: `packages/admin/src/Admin.ts:163`

```
yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
```

## Recommended fix

For cookie clients, either issue the impersonation session under a distinct cookie name (leaving __Host-session intact), or return the original token in the response for the client to retain, or document re-login as the explicit cost of stopImpersonating in browser flows; keep server-side dual-liveness as is.

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
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-007` — Both stop paths refuse to revoke when the audit row is missing or already ended](low/IDS-007-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `admin-impersonation-cookie-contract`. Duplicate of `APS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:164`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
