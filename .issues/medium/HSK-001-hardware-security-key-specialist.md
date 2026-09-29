---
ID: "HSK-001"
Title: "Persisted webauthnUserId is never the user handle the authenticator bound"
Level: medium
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:481"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-001 — Persisted webauthnUserId is never the user handle the authenticator bound

`MEDIUM` · `correctness` · `passkey` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **resolved**

## Summary

registerOptions mints a random user handle and delivers it in the creation options (Passkey.ts:389,394), so that handle is what the authenticator permanently binds into the credential — for a resident hardware key it is the userHandle echoed in every usernameless assertion. registerVerify then mints a *second, different* random value and stores that as the record's webauthnUserId, so the persisted field is guaranteed to mismatch the device-side user handle. Nothing consumes webauthnUserId today (it only round-trips through the table), which makes it dead-but-wrong data: any future userHandle→user correlation (usernameless login via userHandle, cross-device account recovery, MDS enrichment) silently mis-maps, and each of a user's credentials carries a distinct handle, foreclosing the one-handle-per-account convention most ecosystems assume.

## Evidence

Source: `packages/passkey/src/Passkey.ts:481`

```
const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
```

## Recommended fix

Persist the handle that was actually issued in the options — carry it through the ceremony (e.g. store it alongside the challenge in the ChallengeStore scope, or derive it deterministically per user via HKDF(userId, server secret)) and store that value at verify time.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-user-handle`. Duplicate of `BPAS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:591`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BPAS-003-biometric-platform-authenticator-specialist` — closed by its fix (see that issue's Resolved comment).
