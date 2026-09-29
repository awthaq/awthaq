---
ID: "TC-002"
Title: "WebAuthn user handle is random per ceremony step, never a stable per-user value"
Level: medium
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:481"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-002 — WebAuthn user handle is random per ceremony step, never a stable per-user value

`MEDIUM` · `correctness` · `passkey` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **resolved**

## Summary

The port documents userId as 'a per-user, non-PII handle' (packages/ports/src/WebAuthn.ts:93), but the plugin mints a fresh random 32-byte handle at registerOptions (Passkey.ts:389), another at registerOptionsConditional (:412), and a third at registerVerify (:481) — only the last is persisted, and it is never the value the authenticator actually bound during the ceremony. The stored webauthnUserId column is write-only (no code reads it back), and the assertion's userHandle (PasskeyApi.ts:141) is forwarded to the library but never checked against the record. Net effect: one account with two passkeys has two different user handles, which discoverable-credential account choosers and cross-device (hybrid) flows surface as two separate 'accounts', and usernameless correlation via userHandle is impossible. This is the same account being presented as multiple WebAuthn users.

## Evidence

Source: `packages/passkey/src/Passkey.ts:481`

```
const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
```

## Recommended fix

Mint the handle once per user (persist it on the user or derive it deterministically, e.g. HMAC of the internal id), reuse it for every registration ceremony, persist exactly the handle that was sent in the options, and verify the assertion's response.userHandle matches the stored credential's handle.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-user-handle`. Duplicate of `BPAS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:591`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BPAS-003-biometric-platform-authenticator-specialist` — closed by its fix (see that issue's Resolved comment).
