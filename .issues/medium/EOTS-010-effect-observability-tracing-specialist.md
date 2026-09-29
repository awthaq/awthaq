---
ID: "EOTS-010"
Title: "Mailer contract carries token-bearing payloads with no logging prohibition, and layerNoop interpolates recipient email into a die message"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:507"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-010 — Mailer contract carries token-bearing payloads with no logging prohibition, and layerNoop interpolates recipient email into a die message

`MEDIUM` · `security` · `password` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **resolved**

## Summary

Verification and reset tokens travel as plaintext strings inside `MailMessage.data` (`data?: Record<string, unknown>`, packages/ports/src/Mailer.ts:34) through a port whose only contract is send/record — nothing in the port or its docs forbids an implementation from logging `message` (the most natural debugging instinct for a mailer), and BEH-EA-199's interceptor that would catch such a plugin doesn't exist (EOTS-002). `Mailer.layerNoop` also dies with `...dropped a "${message.template}" message to ${message.to}` (Mailer.ts:56), putting the recipient's email address into the defect channel in the very configuration described as 'fails loudly in prod'. A real mailer that logs or a production misconfiguration on layerNoop quietly leaks tokens/PII to logs.

## Evidence

Source: `packages/password/src/Password.ts:507`

```
              template: "verify-email",
              data: { token: encodeVerificationToken(identifier, value) },
```

## Recommended fix

Document a never-log clause on the Mailer port contract, pass tokens as `Redacted` in `data` (unwrapped only by the provider adapter), and drop `message.to` from the layerNoop defect message.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mail-delivery-reliability`. Evidence at HEAD ec065a7: `packages/ports/src/Mailer.ts:50`. Fix: Harden the Mailer contract: tokens as Redacted in data, never-log clause, no PII in layerNoop's defect. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Mailer contract hardened: MailMessage/MailerShape document the never-log clause, layerNoop's defect carries only the template, token mail data is Redacted (VerificationLink.mailData). Tests: Mailer.test.ts (noop defect has no recipient/token), PasswordMail.test.ts (String(data.token) does not reveal it); tests/BDD steps read tokens via a narrowing helper.
