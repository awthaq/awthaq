---
ID: "CB-005"
Title: "Stored user handle never matches the handle bound into the credential; assertion userHandle ignored"
Level: low
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:481"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-005 — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored

`LOW` · `correctness` · `passkey` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

`registerOptions` mints a random 32-byte webauthnUserId that is embedded in the creation options the authenticator persists (line 389-394), but `registerVerify` mints a completely fresh 32-byte value for the stored record — the persisted user handle is never the one the authenticator actually bound. The wire schema carries `userHandle` (PasskeyApi.ts:141) yet the plugin never compares an assertion's userHandle against the stored handle; account identification relies solely on credential id. That is signature-safe (credential id is 1:1 with the record and the signature covers it), but it deviates from L3 §7.2's expectation that a present userHandle maps to the same user account, and makes future per-userHandle flows (e.g. account discovery, MDS AAGUID joins by handle) silently wrong.

## Evidence

Source: `packages/passkey/src/Passkey.ts:481`

```
const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
```

## Recommended fix

Mint the user handle once, echo it through options and persist exactly that value, and in `authenticateVerify` verify `input.credential.response.userHandle` (when present) equals the stored `webauthnUserId`.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: WebAuthn ceremonies
- Full dossier: [`christiaan-brand`](../../.reports/christiaan-brand/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-user-handle`. Duplicate of `BPAS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:692`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
