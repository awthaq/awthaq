---
ID: "BAM-012"
Title: "Impersonation semantics differ from better-auth's cookie-swap model"
Level: info
Category: "api"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/Admin.ts:76"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-012 — Impersonation semantics differ from better-auth's cookie-swap model

`INFO` · `api` · `admin` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

better-auth impersonation swaps the browser's session cookie to a target-owned session and restores the caller's original token afterwards; effect-auth instead issues a dual-identity session carrying actingAs, never touches the caller's own session, records a durable audit row, and adds forceStop/list for episode administration — a stronger audit story, but a different client contract. Admin UIs and support tooling built on better-auth's swap-and-restore behavior need rework at migration even where capability parity exists.

## Evidence

Source: `packages/admin/src/Admin.ts:76`

```
   * configured gate, then issues a dual-identity session for `targetUserId`
```

## Recommended fix

Document the behavioral delta (client must hold both tokens; return-to-admin is a token switch, not a server-side restore) in the migration guide and any admin UI cookbook.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-006` — Impersonation cookie overwrite strands the admin's own live session with no handback](medium/APS-006-auth-pentest-specialist.md) `_(auth-pentest-specialist, medium)_`
- [`BAM-002` — All 11 plugin-owned tables have SQL layers but zero DDL](high/BAM-002-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-005` — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface](high/BAM-005-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`CSS-003` — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie](medium/CSS-003-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`IDS-001` — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account](high/IDS-001-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, high)_`
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-007` — Both stop paths refuse to revoke when the audit row is missing or already ended](low/IDS-007-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `admin-impersonation-cookie-contract`. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:75`. Fix: Document the impersonation client contract (and its delta from better-auth) once APS-006's cookie contract is decided. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
