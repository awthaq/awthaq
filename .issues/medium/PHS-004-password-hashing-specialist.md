---
ID: "PHS-004"
Title: "HIBP response status is never checked; non-2xx resolves to not-breached, bypassing fail-closed mode"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:215"
Auditor: "password-hashing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PHS-004 — HIBP response status is never checked; non-2xx resolves to not-breached, bypassing fail-closed mode

`MEDIUM` · `security` · `password` · reported by **Password Hashing Specialist** (`password-hashing-specialist`)

Status: **resolved**

## Summary

isBreached treats only thrown effects as provider unavailability (the Effect.catch at line 218 maps them to onUnavailable). A non-2xx response - HIBP rate-limits aggressively (429) and serves 503s - is a successful Effect whose body contains an error page, not a SUFFIX:count list, so the suffix match yields false = not breached, and sign-up proceeds even when the operator configured breachCheck: { onUnavailable: 'reject' }. The documented fail-closed posture (BEH-EA-119: 'HIBP unreachable -> fail-closed when configured') is therefore bypassable by exactly the provider-error conditions it exists for. The same mechanism also silently downgrades a truncated or malformed 200 body.

## Evidence

Source: `packages/password/src/Password.ts:215`

```
const response = yield* httpClient.get(`https://api.pwnedpasswords.com/range/${prefix}`);
    const body = yield* response.text;
    return body.split("\n").some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
```

## Recommended fix

Check response.status explicitly (or pipe the client through HttpClient.filterStatusOk) and route any non-200 through the same onUnavailable policy; ideally also treat a body that lacks the HIBP line shape as unavailable rather than as an empty corpus.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Password hashing
- Full dossier: [`password-hashing-specialist`](../../.reports/password-hashing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `password-policy-posture`. Already fixed by commit 25d991e. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:316`. Fix: Treat an unparseable HIBP body and a slow provider as 'unavailable'. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** isBreached validates the HIBP body (every non-empty line must match ^[0-9A-F]{35}:\d+$, empty body counts as unavailable) and applies PasswordConfig.breachCheckTimeout (default 3s); both route to onUnavailable. Tests (red first): PasswordPolicy.test.ts (HTML body fails closed under reject and open by default; never-responding lookup times out per TestClock).
