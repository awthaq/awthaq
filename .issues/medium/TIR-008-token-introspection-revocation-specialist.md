---
ID: "TIR-008"
Title: "No auth.session.revoked event - revocation is invisible to subscribers"
Level: medium
Category: "architecture"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:259"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-008 — No auth.session.revoked event - revocation is invisible to subscribers

`MEDIUM` · `architecture` · `admin` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **resolved**

## Summary

The AuthEvents taxonomy (packages/core/src/AuthEvents.ts:23-207) covers token replay, user lifecycle, passkey anomalies, impersonation, and the full organization surface, but has no event for the core revocation mutations themselves: Sessions.revoke/revokeOthers/revokeAll publish nothing in either layer. Only impersonation stop/forceStop announce their revocations, and they can only do so because the Admin plugin publishes around the call - ordinary revocation (device sign-out, revoke-others after password change) propagates to no subscriber: no audit trail event, no cache-invalidation signal, no hook for a future introspection cache to act on. For a runtime whose spec (spec/behaviors/13-events.md, BEH-EA-097/098) invests in a bounded PubSub precisely for cross-cutting visibility, revocation being silent is a meaningful design gap.

## Evidence

Source: `packages/admin/src/Admin.ts:259`

```
yield* sessions.revoke(Sessions.SessionId(caller.sessionId)).pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.admin.impersonationStopped",
```

## Recommended fix

Add auth.session.revoked (sessionId, userId, cause) and auth.session.revokedAll (userId, cause) to the AuthEvent union and publish from both Sessions layers' revoke paths (cause: 'user' | 'passwordReset' | 'admin'), keeping the bounded-PubSub fire-and-forget contract so revoke latency is unaffected.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token revocation & introspection
- Full dossier: [`token-introspection-revocation-specialist`](../../.reports/token-introspection-revocation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-revocation-events`. Already fixed by commit 45325bb. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:90`. Fix: Publish revocation from the Sessions primitives themselves with a per-row identity and a cause, so every revocation path is observable and durably audited. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Closed with ESA-006 (same implementation): every Sessions revocation primitive takes a required reason and publishes exactly one auth.session.revoked after the delete (sessionId for scope one, null for others/all/family); callers: server Session.ts (signOut, userRevoked), Account.ts (userDeleted), Password (passwordChanged/passwordReset; its manual publishes removed), Admin (impersonationStopped), reuse detection (reuseDetected). Tests: core Sessions.test.ts eventsSuite (both layers) and server AuthHttp.test.ts 'POST /session/sign-out records a signOut auth.session.revoked in AuditLog'; password tests confirm exactly one event per path.
