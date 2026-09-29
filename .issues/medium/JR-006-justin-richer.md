---
ID: "JR-006"
Title: "impersonate overwrites the browser's session cookie with the impersonation token, so the no-handback stop flow logs the admin out of the browser"
Level: medium
Category: "correctness"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:163"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-006 — impersonate overwrites the browser's session cookie with the impersonation token, so the no-handback stop flow logs the admin out of the browser

`MEDIUM` · `correctness` · `admin` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

BEH-EA-216 specifies stopImpersonating 'MUST NOT issue any replacement session — the caller is expected to already hold their own original session's token', and BEH-EA-213 requires the caller's own session remain valid server-side. But in cookie mode the impersonate handler replaces the single `__Host-session` cookie with the impersonation token, destroying the browser's copy of the admin's original credential. After stopImpersonating (correctly no handback), the browser holds a revoked token: the admin is silently logged out instead of returning to their admin session. The server-side property holds; the browser-facing single-cookie contract contradicts the spec's client-side assumption. A native client juggling tokens is fine; the cookie-mode handler is not.

## Evidence

Source: `packages/admin/src/Admin.ts:163`

```
yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
```

## Recommended fix

Either restore the admin session at stop time (requires the handler to remember it — e.g. an HttpOnly admin-session cookie held aside for the impersonation's duration), or issue the impersonation credential under a distinct cookie/header so the admin session cookie survives; document whichever browser contract is chosen in BEH-EA-213/216.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `admin-impersonation-cookie-contract`. Duplicate of `APS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:164`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `APS-006-auth-pentest-specialist` — closed by its fix (see that issue's Resolved comment).
