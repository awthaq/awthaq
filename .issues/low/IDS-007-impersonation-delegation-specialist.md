---
ID: "IDS-007"
Title: "Both stop paths refuse to revoke when the audit row is missing or already ended"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/Admin.ts:252"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-007 — Both stop paths refuse to revoke when the audit row is missing or already ended

`LOW` · `correctness` · `admin` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **ready-for-agent**

## Summary

stopImpersonating (and forceStop identically at Admin.ts:277-284) closes the episode first and only then revokes the session; an ImpersonationRecordNotFound (row lost, purged by retention, or written to a different store than the session store) aborts the whole call with 404, leaving the impersonation session alive with no API path to end it. Blast radius is capped by the hard expiry, but a host configuring a long maxDuration couples session termination to audit-row availability - the revocation (the safety-critical act) should not be a casualty of audit-state drift.

## Evidence

Source: `packages/admin/src/Admin.ts:252`

```
yield* records
            .endEpisode(caller.sessionId, "self")
            .pipe(
```

## Recommended fix

Revoke the session first (idempotently) and record the end best-effort, or treat missing-row + actingAs-carrying session as revocable-with-warning instead of 404.

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
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-impersonation-lifecycle`. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:316`. Fix: Make revocation the primary, idempotent act on both stop paths and record the episode end best-effort, without letting forceStop revoke sessions that are not provably impersonation sessions. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
