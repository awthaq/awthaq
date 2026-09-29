---
ID: "HSK-004"
Title: "Counter-regression (cloned-key) signal is published to a volatile in-memory bus with no enforcement"
Level: medium
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:588"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-004 — Counter-regression (cloned-key) signal is published to a volatile in-memory bus with no enforcement

`MEDIUM` · `security` · `passkey` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **resolved**

## Summary

For a CTAP hardware key the signature counter is the only clone detector, and this code deliberately treats regression as log-and-continue (reasonable per BEH-EA-131's comment, since 0===0 is normal for synced passkeys). But the 'log' is one publish into AuthEvents' bounded in-process PubSub (core/src/AuthEvents.ts:263) — no persistence, no cross-instance delivery, no subscribed consumer exists in the repo, and the credential is never flagged or invalidated. In any multi-instance deployment a cloned YubiKey authenticates indefinitely while its anomaly events evaporate; even single-instance, an operator must already be streaming the bus to know anything happened. The code comment promises 'log + step-up' but no step-up mechanism is wired to this event anywhere.

## Evidence

Source: `packages/passkey/src/Passkey.ts:588`

```
if (counterRegressed) {
      yield* events.publish({
        _tag: "auth.passkey.counterAnomaly",
```

## Recommended fix

Persist anomaly state (a flagged column on passkey_credential, updated in recordUsage) so policy can act on it at the next ceremony, and/or document that production deployments MUST attach a durable AuthEvents subscriber; consider distinct handling for singleDevice credentials where 0-count regression is not expected.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-counter-anomaly-policy`. Duplicate of `WPS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:796`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `WPS-006-webauthn-passkeys-specialist` — closed by its fix (see that issue's Resolved comment).
