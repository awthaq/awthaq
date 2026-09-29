---
ID: "TC-005"
Title: "userVerification:'discouraged' config is silently unenforceable for ordinary registration"
Level: low
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:477"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-005 — userVerification:'discouraged' config is silently unenforceable for ordinary registration

`LOW` · `correctness` · `passkey` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **resolved**

## Summary

Ordinary (non-conditional) registration hard-requires userVerified (enforceUserVerification is true for every challenge consumed from the ordinary scope, Passkey.ts:452), and a test pins this as deliberate (Passkey.test.ts:437-469). But the same config object feeds authenticatorSelection into the ceremony options (Passkey.ts:399): an operator who sets authenticatorSelection.userVerification to 'discouraged' tells the authenticator to skip UV and then rejects the resulting UV=false response — every ordinary registration fails on authenticators that honor the request. The config surface neither documents nor refuses this combination, and the conditional path sets its own UV so it alone would work.

## Evidence

Source: `packages/passkey/src/Passkey.ts:477`

```
if (enforceUserVerification && !verified.userVerified) {
            return yield* Effect.fail(new PasskeyApi.PasskeyUserVerificationRequired());
          }
```

## Recommended fix

Derive the ordinary-path UV enforcement from config.authenticatorSelection.userVerification (enforce only when 'required'), or validate config() at layer construction and reject incompatible combinations with an explicit error.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Passkey standards posture
- Full dossier: [`tim-cappalli`](../../.reports/tim-cappalli/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `passkey-ceremony-policy`. Already fixed by commit 1f2df3a. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:662`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
