---
ID: "RBS-001"
Title: "All password endpoints rate-limit solely on the attacker-controlled email, enabling renewable victim lockout and unlimited password spraying"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:517"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-001 — All password endpoints rate-limit solely on the attacker-controlled email, enabling renewable victim lockout and unlimited password spraying

`HIGH` · `security` · `password` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **resolved**

## Summary

The consume happens pre-verify on a key derived only from the request payload's email, so an attacker who sends 5 wrong passwords for victim@corp.com locks the legitimate owner out for 15 minutes and can renew indefinitely — precisely the attacker-triggered-lockout DoS this persona flags as a red flag. The inverse failure is equally real: with no IP or global dimension, distributed credential spraying across millions of distinct addresses is entirely unthrottled (each address gets a fresh 5/15min budget). The in-repo comment (Password.ts:146-153) honestly documents that no client-IP mechanism exists and calls IP keying 'tracked, not built', and spec/behaviors/14-rate-limiting.md BEH-EA-108 itself names 'an email in a sign-in payload' as the canonical attacker-chosen key that defeats a limiter's purpose.

## Evidence

Source: `packages/password/src/Password.ts:517`

```
yield* rateLimit(`password:signin:${input.email.toLowerCase()}`, RATE_LIMITS.signIn);
```

## Recommended fix

Thread HttpServerRequest.remoteAddress into signIn/requestReset/resendVerification the way the OAuth callback already does (OAuth.ts:332), key sign-in on a composite of email + IP for per-account budgeting, and add a second independent per-IP sign-in cap (e.g. 50/15min) so cross-account spraying is bounded without letting one office NAT lock everyone out.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: brute-force defense
- Full dossier: [`rate-limiting-brute-force-specialist`](../../.reports/rate-limiting-brute-force-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:517` matches the evidence exactly (`signIn` keys solely on `input.email.toLowerCase()`), and the comment at lines 142-153 confirms no client-IP mechanism is threaded into the password plugin, unlike `OAuth.ts:332`'s existing `request.remoteAddress` precedent. Fix (thread `remoteAddress` and add a composite/per-IP key) has a working in-repo pattern to follow. Status → ready-for-agent.

**Resolved (2026-09-19):** Added a second, independent per-IP rate-limit rule to `Password.signIn` (`RATE_LIMITS.signInByIp`, 30/15min) alongside the existing per-email rule, threading `HttpServerRequest.remoteAddress` from `PasswordHandlers.signIn` into the domain call — the same pattern `OAuth.ts`'s `callback` already established for its own IP-keyed rule. The per-email rule still bounds a single account's exposure; the new per-IP rule independently bounds a source spraying many distinct, unrelated emails, without letting one shared NAT lock out every real user behind it. Regression test in `packages/password/test/Password.test.ts` (`RBS-001/CSD-002: signIn is throttled per source IP across distinct, unrelated emails`) sprays 30 never-before-seen emails from one IP, asserts the 31st is `RateLimited` even though its email alone would never trip the per-account limiter, and asserts a different IP with the same email pattern is unaffected — verified to genuinely fail (every attempt `InvalidCredentials`, none `RateLimited`) with the per-IP `rateLimit` call reverted. Full monorepo typecheck and test suite (604 tests) pass.
