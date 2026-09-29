---
ID: "WPS-006"
Title: "Cloned-authenticator detection is log-only; PasskeyCounterAnomaly is declared but never emitted"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:589"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-006 — Cloned-authenticator detection is log-only; PasskeyCounterAnomaly is declared but never emitted

`MEDIUM` · `security` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **ready-for-agent**

## Summary

Counter regression is correctly detected (including the 0===0 carve-out for cloud-synced passkeys and the equal-counter case) but the only consequence is one publish into AuthEvents' bounded in-process PubSub — no persistence, no credential flag, no step-up, and no subscriber exists in the repo, so in any multi-instance deployment the signal is lost. The contract declares PasskeyCounterAnomaly (PasskeyApi.ts:116-120) yet no endpoint can ever return it, and the matching scenario REQ-EA-381 is @skip-tagged as a spec/implementation divergence. The persona's red flag is skipping counter validation — validation exists, but enforcement is structurally inert.

## Evidence

Source: `packages/passkey/src/Passkey.ts:589`

```
yield* events.publish({
  _tag: "auth.passkey.counterAnomaly",
  userId: stored.userId,
```

## Recommended fix

Persist anomaly state (a flagged column updated in recordUsage) so policy can act at the next ceremony, attach a durable AuthEvents subscriber requirement to production docs, and either emit PasskeyCounterAnomaly under an explicit strict policy or remove it from the contract.

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `passkey-counter-anomaly-policy`. Already fixed by commit 6bd3f1d. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:796`. Fix: Persist anomaly state on the credential and let policy act on it; raise PasskeyCounterAnomaly under the strict policy (CB-004). (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
