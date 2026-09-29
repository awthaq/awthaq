---
ID: "CSD-006"
Title: "Stale comment claims no client-IP mechanism exists, documenting away the missing IP dimension"
Level: medium
Category: "architecture"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:146"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-006 — Stale comment claims no client-IP mechanism exists, documenting away the missing IP dimension

`MEDIUM` · `architecture` · `password` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

This rationale is no longer true: the OAuth callback handler extracts the client address from HttpServerRequest.remoteAddress (OAuth.ts:332, storing `ip` in flow state) and enforces a per-IP rate-limit bucket `oauth:callback:${input.ip ?? "unknown"}` (OAuth.ts:509, 20/min, shared bucket when the IP is unknown). The mechanism the password plugin says it would need for IP-keyed signIn throttling already exists one plugin over. The stale comment presents email-only keying as forced by the codebase rather than as a choice, which misdirects future hardening work.

## Evidence

Source: `packages/password/src/Password.ts:146`

```
 * here keys on identity/email, never IP: this codebase has no client-IP-
 * extraction mechanism anywhere yet (no handler threads a request's
 * origin into a domain capability today), and building one speculatively
```

## Recommended fix

Correct the comment to cite OAuth's remoteAddress pattern as the in-repo precedent, and adopt it: handlers can access the request, so a second IP-keyed rateLimit call in signIn is incremental work, not new infrastructure.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-rate-limit-hardening`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:210`. Fix: Rewrite the RATE_LIMITS header comment. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Rewrote the rate-limit header comment (now packages/password/src/PasswordRateLimits.ts): describes the two-dimension scheme (identity budgets + per-source budgets via the ClientAddress port, unknown IPs sharing one bucket). No comment claims IP extraction is missing.
