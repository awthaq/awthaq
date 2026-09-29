---
ID: "EEM-002"
Title: "Mailer port types delivery as Effect<void> — an expected operational failure forced into the defect channel"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/Mailer.ts:38"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-002 — Mailer port types delivery as Effect<void> — an expected operational failure forced into the defect channel

`HIGH` · `architecture` · `ports` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **ready-for-agent**

## Summary

Mail delivery failure (SMTP down, bad template, provider 5xx) is precisely the kind of recoverable, expected condition the error channel exists for, but the port declares E = never. The port's own layerNoop precedent (line 54) shows the only representable failure mode: Effect.die. Production implementations must therefore either swallow errors silently (masking bugs) or crash the calling request as a defect — and callers (requestReset, resendVerification) cannot catch-and-degrade even where degrading is the security-correct behavior. The port contract actively pushes implementers toward the defect channel the rest of this codebase works so hard to keep clean.

## Evidence

Source: `packages/ports/src/Mailer.ts:38`

```
export interface MailerShape {
  readonly send: (message: MailMessage) => Effect.Effect<void>;
```

## Recommended fix

Type send as Effect.Effect<void, MailDeliveryFailed> (carrying provider/reason for logs, no secrets), and let callers choose: fork-and-forget in signUp, catch-and-still-202 in requestReset/resendVerification.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`SOS-003` — Mailer.send has no error channel, so channel delivery failure is untypeable — fatal for SMS where provider failure is routine](medium/SOS-003-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/ports/src/Mailer.ts:38` exactly; `layerNoop` (line 50-62) does route failure through `Effect.die`, confirming the port offers no typed failure path today. Widening the signature to `Effect.Effect<void, MailDeliveryFailed>` with per-caller handling (fork-and-forget vs. catch-and-202) is a concrete, mechanical change. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mailer-typed-delivery-errors`. Evidence at HEAD ec065a7: `packages/ports/src/Mailer.ts:37`. Fix: Give Mailer.send a typed MailDeliveryFailed error and make every caller choose a policy. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.
