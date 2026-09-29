---
ID: "HSK-007"
Title: "Conditional Create hardcodes residentKey:\"required\", silently excluding CTAP1-only and older-CTAP2 hardware keys"
Level: low
Category: "dx"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:425"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-007 — Conditional Create hardcodes residentKey:"required", silently excluding CTAP1-only and older-CTAP2 hardware keys

`LOW` · `dx` · `passkey` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **resolved**

## Summary

The conditional endpoint overrides the operator's selection with residentKey:"required" + userVerification:"discouraged" (commented as Chrome-autofill-driven, so the intent is sound). The practical consequence for roaming authenticators: CTAP1/U2F-only keys and early-CTAP2 firmware without discoverable-credential support cannot complete this ceremony at all and get an opaque failure, while the ordinary path's default residentKey:"preferred" degrades gracefully for exactly those keys. The persona's red flag — assuming all hardware keys support resident credentials equally — is half-avoided: the default is right, the conditional path is not. Hardware keys are unlikely candidates for autofill UI, so the blast radius is small, but the exclusion is undocumented.

## Evidence

Source: `packages/passkey/src/Passkey.ts:425`

```
authenticatorSelection: {
              ...config.authenticatorSelection,
              residentKey: "required",
```

## Recommended fix

Document on PasskeyConditionalCreateDisabled/conditionalCreate that the conditional ceremony requires discoverable-credential support (CTAP2), or gate the endpoint's advertised availability on a config flag so enterprises with U2F-only fleets don't surface a broken entry point.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-ceremony-policy`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:628`. Fix: Document the discoverable-credential (CTAP2.1+ / platform) requirement of the conditional ceremony. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Documented the discoverable-credential (CTAP2.1+/platform) requirement and the conditionalCreate:false opt-out on PasskeyConfigShape.conditionalCreate, PasskeyApi.PasskeyConditionalCreateDisabled and the README. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
