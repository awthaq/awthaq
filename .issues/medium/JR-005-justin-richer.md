---
ID: "JR-005"
Title: "Impersonation is full-authority identity assumption: no scoped-delegation primitive exists, and the act claim deviates from RFC 8693"
Level: medium
Category: "architecture"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:226"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-005 — Impersonation is full-authority identity assumption: no scoped-delegation primitive exists, and the act claim deviates from RFC 8693

`MEDIUM` · `architecture` · `admin` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

The only authority-transfer primitive issues a session FOR the target with the target's complete permission set; restriction is left to policies voluntarily branching on subject.attributes.actingAs (BEH-EA-142, and the appendix example 'an impersonating admin may look, not delete'). There is no way to delegate a subset of authority — no scope/permission parameter on impersonate, no consent by the target, no may_act — i.e. impersonation yes, delegation (the OAuth/GNAP notion of a limited grant) no. Secondary interop gap: the JWT act claim is emitted as `{ act: { type, id } }` (packages/jwt/src/Jwt.ts:98-100, self-described 'RFC 8693-style'), but RFC 8693's act claim is a sub-keyed actor chain; a compliant downstream verifier cannot recognize the admin behind the token.

## Evidence

Source: `packages/admin/src/Admin.ts:226`

```
.issue({
            userId: targetUserId,
            actingAs: { type: caller.ref.type, id: caller.ref.id },
```

## Recommended fix

Keep impersonation as-is for support flows, but consider an `actingAs`-scoped permission filter (or a separate delegation grant) so policy authors get restriction by default rather than by opt-in discipline; and emit `act: { sub: <admin id> }` (keeping type/id as private-claim extensions) so downstream RFC 8693-aware verifiers can parse the actor chain.

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

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `jwt-act-claim`. Evidence at HEAD ec065a7: `packages/admin/src/Admin.ts:290`. Fix: Emit an RFC 8693-compliant `act` claim (`act.sub`) while keeping type/id as private extensions. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Jwt.ts principalClaims now emits act { sub: <actor id>, awthaq_actor_type } (RFC 8693 4.1); the Jwt.test 'populates act' expectation updated; packages/jwt/test/JwtIntrospection.test.ts 'an impersonation session's minted JWT carries act.sub = the admin's id, non-impersonation tokens no act'; packages/admin/README.md documents full-authority impersonation and the qadi policy over actingAs (BEH-EA-142). No verify.ts decoder of act exists (act rides as an extra claim).
