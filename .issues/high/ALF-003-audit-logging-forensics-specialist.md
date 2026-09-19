---
ID: "ALF-003"
Title: "No event on sign-in failure — brute-force and takeover attempts are invisible to the event stream"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:539"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-003 — No event on sign-in failure — brute-force and takeover attempts are invisible to the event stream

`HIGH` · `security` · `password` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

signIn publishes auth.user.signedIn on success only (:560). Both failure paths — InvalidCredentials (:539) and EmailNotVerified (:549) — publish nothing. Failed authentication is the single most important forensic signal for detecting and later reconstructing brute-force and credential-stuffing campaigns; the rate limiter counts attempts per email internally but no event, durable or in-memory, ever records a failure, so no subscriber can alert and no timeline can show that an attack happened. The uniform-response discipline correctly hides the failure reason from the attacker but is over-applied to the audit channel, where the distinction (and the attempt itself) is exactly what defenders need.

## Evidence

Source: `packages/password/src/Password.ts:539`

```
          return yield* Effect.fail(new Api.InvalidCredentials());
```

## Recommended fix

Add an auth.user.signInFailed tag to the closed union and publish on every signIn failure path (strategy plus a coarse reason class; keep the email out of the payload), from both the memory and SQL code paths.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:539` (`InvalidCredentials`) and `:549` (`EmailNotVerified`) match the quoted evidence; a grep for `events.publish`/`_tag: "auth.` in the file shows only `auth.user.created` (:495) and `auth.user.signedIn` (:560-561) are ever published — no failure event on either path. Adding a `signInFailed` tag and publish calls is a well-scoped, mechanical change. Status → ready-for-agent.

**Resolved (2026-09-19):** Added `auth.user.signInFailed` (`AuthEvents.ts`) — `{ strategy, reason: "invalidCredentials" | "emailNotVerified" }` — published from `Password.ts`'s `signIn` on both failure paths (before the uniform `InvalidCredentials`/`EmailNotVerified` failures return). Deliberately carries no `userId`/email: the wire response's uniform-response discipline (BEH-EA-116) is about hiding the reason from the *caller*, not from a legitimate audit subscriber, but a *present* `userId` field would itself leak account existence through the event's own shape for the `invalidCredentials` case (which fires for a nonexistent email too) — the same oracle relocated to whoever is watching the event stream instead of closed.

TDD: two new tests in `packages/password/test/Password.test.ts`, using the same `events.stream`/`Effect.forkChild`/`Fiber.join` pattern `Verification.test.ts`'s own `auth.token.replay` test already established — one per failure reason, asserting the event's `reason` field and that no `userId`/`email` property is present. Verified to genuinely fail (test timeout, since the awaited event never publishes) with the fix reverted. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (649 tests).
