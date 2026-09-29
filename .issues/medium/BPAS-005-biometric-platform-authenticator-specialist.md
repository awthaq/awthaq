---
ID: "BPAS-005"
Title: "Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX"
Level: medium
Category: "dx"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:477"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-005 — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX

`MEDIUM` · `dx` · `passkey` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **resolved**

## Summary

Default options request userVerification:preferred (Passkey.ts:66), yet ordinary-scope registerVerify hard-fails any UV=0 result. On devices where the browser legitimately skips UV under 'preferred' — a Windows Hello setup with no verifier configured, a FIDO2 security key without a PIN — the user completes the entire biometric/credential ceremony and only then receives PasskeyUserVerificationRequired, a dead end with no recovery path. This is exactly the mismatch research/06 line 248 warns to avoid (enforce UV at verification per step-up policy) and the persona red flag of assuming every device has a working UV-capable authenticator. The authentication path gets this right (fails only when config says required); registration does not.

## Evidence

Source: `packages/passkey/src/Passkey.ts:477`

```
if (enforceUserVerification && !verified.userVerified) {
            return yield* Effect.fail(new PasskeyApi.PasskeyUserVerificationRequired());
```

## Recommended fix

Either request userVerification:required in ordinary registration options whenever the server will enforce UV, or accept UV=0 on the ordinary path when config is preferred — derive the verification-time policy from the same config value the options were minted from, as authenticateVerify already does.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `passkey-ceremony-policy`. Already fixed by commit 1f2df3a. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:662`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
