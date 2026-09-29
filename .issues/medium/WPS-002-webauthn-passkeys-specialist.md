---
ID: "WPS-002"
Title: "Stored webauthnUserId is fabricated at verify time, never the handle the authenticator saw, and is never validated"
Level: medium
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:481"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-002 — Stored webauthnUserId is fabricated at verify time, never the handle the authenticator saw, and is never validated

`MEDIUM` · `correctness` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **resolved**

## Summary

registerOptions mints a random 32-byte handle and embeds it in the credential-creation options (Passkey.ts:389) — that is the userHandle the authenticator will bind and echo back in assertions. registerVerify then generates a brand-new random handle (this line) and stores that in passkey_credential, so the persisted value can never match anything real; each credential also gets a different handle, violating the WebAuthn guidance that the user handle is a stable per-account identifier. authenticateVerify looks up exclusively by credential id and never compares the assertion's userHandle to the stored value, so the column is dead, misleading data (the port's own doc at packages/ports/src/WebAuthn.ts:93 calls it "a per-user, non-PII handle").

## Evidence

Source: `packages/passkey/src/Passkey.ts:481`

```
const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
```

## Recommended fix

Persist the handle that was actually embedded in the options (stable per user — mint once on first credential), and when an assertion carries userHandle, verify it matches the stored value; otherwise delete the column and the misleading doc.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-user-handle`. Duplicate of `BPAS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:692`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
