---
ID: "THS-003"
Title: "Sessions carry no amr/trust/assurance field recording which factors authenticated the principal"
Level: medium
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:90"
Auditor: "totp-hotp-mfa-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# THS-003 — Sessions carry no amr/trust/assurance field recording which factors authenticated the principal

`MEDIUM` · `security` · `core` · reported by **TOTP/HOTP MFA Specialist** (`totp-hotp-mfa-specialist`)

Status: **resolved**

## Summary

SessionView's nine fields (id, userId, createdAt, lastActiveAt, absoluteExpiresAt, idleExpiresAt, ipAddress, userAgent, actingAs) include no amr/aal/trust evidence. The divert-before-issue design compensates partially at sign-in (no session exists until 2FA completes), but nothing downstream can distinguish a password-only session from a password+TOTP one: step-up re-authentication for sensitive operations, AAL-style policy decisions, and audit questions ('was this session 2FA?') are all unanswerable. The actingAs field (Sessions.ts:84-87, BEH-EA-209) is the established precedent for a generic, plugin-agnostic metadata field on a session view — an amr/factors field would fit the same pattern.

## Evidence

Source: `packages/core/src/Sessions.ts:90`

```
export interface SessionView {
  readonly id: SessionId;
  readonly userId: UserId;
```

## Recommended fix

When two-factor lands, add an authentication-methods-evidence field to the session shape (e.g. amr: ReadonlyArray<string> or a branded factors record), populated by the issuing plugin through the divert/issue path, and expose it in SessionView/SessionDto so authorization code (qadi) can write obligations like 'requires mfa' against real data.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 24/100), domain: TOTP/HOTP MFA
- Full dossier: [`totp-hotp-mfa-specialist`](../../.reports/totp-hotp-mfa-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-policy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:92`. Fix: Add RFC 8176 `amr` evidence to sessions: set at issue by the authenticating plugin, extendable by reauthenticate, exposed on SessionView/SessionListItem/SessionDto. (effort L). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** core Sessions.ts: closed AuthMethod union (RFC 8176: pwd|hwk|swk|user|otp|mfa|fed|email), issue({amr?}), SessionRow/SessionView/SessionListItem.amr, reauthenticate(id, amr?) unions (order-preserving, deduplicated, monotone; unionAmr exported), parseAmr drops unknown values. SQL: Models.Session.amr (JSON-array text, constructor default '[]', no update variant), migration 19 add_sessions_amr_column (NOT NULL DEFAULT '[]'), SessionsRepository.reauthenticate takes the already-unioned JSON (COALESCE). api SessionDto.amr (decoding default [] + constructor default), server Session.ts/password/passkey/admin DTO builders. Callers: password signUp/signIn/changePassword [pwd] and reauthenticate; OAuth [fed]; passkey [hwk] + user when UV (issue and reauthenticate); legacy bridge and impersonation none. Tests: core Sessions.test.ts both layers (issue/verify/list/findOwned round-trip, none by default, reauthenticate union), password/oauth/passkey amr assertions. Spec: BEH-EA-049 paragraph. Deferred: qadi Subject attribute exposure (step 4, coordinate with qadi owners) -- the resolved UserPrincipal now carries amr for qadi's SubjectResolver to read. Touches password/passkey/oauth/admin sources.
