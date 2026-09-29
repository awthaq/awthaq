---
ID: "MLO-009"
Title: "Token encoding embeds the raw identifier+secret with no canonical delivery format, leaving link shape entirely to consumers"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/Password.ts:177"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-009 — Token encoding embeds the raw identifier+secret with no canonical delivery format, leaving link shape entirely to consumers

`MEDIUM` · `architecture` · `password` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **ready-for-agent**

## Summary

The mailed artifact is a bare dotted string, not a URL, an OTP, or a template; the encoding is well-documented (lines 168-176: split on last '.') but there is no link builder, no expiry display data (the mail payload carries only the token, not expiresAt), and no OTP-digit variant. Link-vs-OTP tradeoffs - the persona's daily design decision - are therefore made ad hoc by every integrating app: token-in-query GET links leak via Referer/server logs/browser history and are prefetch-burned by security scanners; there is no fallback when a link arrives dead (the user's 'expired instantly' report has no in-library answer). POST-only API consumption (verifyEmail/confirmReset are HttpApiEndpoint.post) is the one shipped mitigation, and it is a good one.

## Evidence

Source: `packages/password/src/Password.ts:177`

```
const encodeVerificationToken = (identifier: string, value: Redacted.Redacted<string>): string =>
  `${identifier}.${Redacted.value(value)}`;
```

## Recommended fix

Ship a small delivery helper with M7: an opinionated URL builder (token in POST body or single-use opaque path segment, never query string), an EmailOtp digit-code formatter, and template data including expiresAt so apps render usable, scanner-safe mail without inventing formats.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Passwordless Email Tokens
- Full dossier: [`magic-link-email-otp-specialist`](../../.reports/magic-link-email-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-token-delivery`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:271`. Fix: Extract a shared, purpose-checked token codec + link builder into core and give every mailed token {url, token, expiresAt}. (effort M). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.
