---
ID: "SMS-004"
Title: "Request ip/userAgent never recorded — the device list ships empty"
Level: medium
Category: "dx"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:559"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-004 — Request ip/userAgent never recorded — the device list ships empty

`MEDIUM` · `dx` · `password` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **resolved**

## Summary

Sessions.issue accepts request.ip/userAgent and the schema/migrations store them (ipAddress/userAgent columns, Models.ts:116-117), but no production call site passes them: password signUp (line 494) and signIn (line 559), OAuth (OAuth.ts:729) and passkey (Passkey.ts:599) all issue with userId only. The plugin make-layer has no ambient HttpServerRequest, so nothing bridges it in. Every device-list row therefore renders userAgent: null, making BEH-EA-054's 'each with its own userAgent' scenario unachievable in practice and users unable to recognize which device they are revoking.

## Evidence

Source: `packages/password/src/Password.ts:559`

```
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

## Recommended fix

Capture ip/userAgent in the HTTP handlers (the request is ambient there) and thread them through the plugin sign-in calls into sessions.issue, e.g. by passing a request-metadata struct alongside the payload or reading HttpServerRequest inside the handler group before calling the plugin.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-issuance-context`. Duplicate of `CSD-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:866`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `CSD-003-credential-stuffing-defense-specialist` — closed by its fix (see that issue's Resolved comment).
