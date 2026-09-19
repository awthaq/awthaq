---
ID: "CSD-002"
Title: "signIn throttling is keyed on email only — no IP or global dimension, so stuffing at scale is unthrottled"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:517"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-002 — signIn throttling is keyed on email only — no IP or global dimension, so stuffing at scale is unthrottled

`HIGH` · `security` · `password` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

The only login throttle is 5 attempts per 15 minutes per email (RATE_LIMITS.signIn, line 157). The file's own comment (lines 146-153) admits every rule keys on identity/email, never IP. The canonical credential-stuffing pattern — one guess per credential across millions of records, distributed over many IPs — never exceeds 1-2 attempts per email and passes entirely unthrottled; the attacker's aggregate rate is bounded only by the server's capacity. Conversely, the email key lets an attacker deliberately burn a victim's 5 attempts (429 with retryAfterMillis) to lock a real user out for up to 15 minutes, with no IP dimension to attribute or throttle the abuser. Both directions of the classic per-account-only trade-off are unmitigated.

## Evidence

Source: `packages/password/src/Password.ts:517`

```
yield* rateLimit(`password:signin:${input.email.toLowerCase()}`, RATE_LIMITS.signIn);
```

## Recommended fix

Add a second, IP-keyed consume alongside the email key using the remoteAddress machinery OAuth already uses (see CSD-006), plus a coarse global velocity limit on failed attempts; consider an escalating-backoff or step-up-challenge response for the per-account bucket instead of a hard 429 lockout.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:517` keys sign-in throttling solely on `password:signin:${input.email.toLowerCase()}`, and the file's own comment at lines 142-154 states every `RATE_LIMITS` rule "keys on identity/email, never IP" and that IP-based keying is "tracked, not built here." By contrast, `packages/oauth/src/OAuth.ts:332,417-438` already extracts `request.remoteAddress` and registers a real per-IP callback rate-limit rule — confirming the "remoteAddress machinery OAuth already uses" precedent cited in the recommended fix. Adding an analogous IP-keyed rule to password sign-in is a mechanical, pattern-following change. Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `RBS-001` (shared source line, same root cause) — see that finding's comment for the implementation and verification detail.
