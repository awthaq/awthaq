---
ID: "AGA-007"
Title: "Password rate limits are identity-keyed only: proxy-safe, but network-level throttling is silently delegated to the gateway"
Level: low
Category: "dx"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:517"
Auditor: "api-gateway-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AGA-007 — Password rate limits are identity-keyed only: proxy-safe, but network-level throttling is silently delegated to the gateway

`LOW` · `dx` · `password` · reported by **API Gateway Auth Specialist** (`api-gateway-auth-specialist`)

Status: **resolved**

## Summary

All six password limiter call sites key on identity (email at lines 471/517/570/595, identifier at 629, userId at 698) and none on network origin — so, unlike the OAuth callback rule, these limits work identically behind any proxy and can never NAT-lock an office (a failure mode spec BEH-EA-108 explicitly names). The trade-off is that there is no per-IP spray dimension anywhere in the application: one host hammering thousands of distinct emails meets no in-app limit, because the repo implicitly assumes the gateway supplies network-level throttling — an assumption stated nowhere (STACK.md:113 lists IP/XFF CIDR limiting as a not-yet-built plugin idea). For the gateway operator this is an undocumented contract: deploy without an edge rate limiter and credential-stuffing across accounts is unthrottled by effect-auth.

## Evidence

Source: `packages/password/src/Password.ts:517`

```
yield* rateLimit(`password:signin:${input.email.toLowerCase()}`, RATE_LIMITS.signIn);
```

## Recommended fix

Document the intended division of labor in the deployment spec — identity-scoped brute-force limits in-app (shipped), network-scoped spray limits at the gateway or via a future trusted-proxy-aware IP rule (operator-provided) — so the implicit contract becomes an explicit checklist item.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Gateway deployment posture
- Full dossier: [`api-gateway-auth-specialist`](../../.reports/api-gateway-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-rate-limit-hardening`. Already fixed by commit 349e220. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:233`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
