---
ID: "CB-006"
Title: "authenticateOptions leaks account existence via allowCredentials population"
Level: low
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:513"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-006 — authenticateOptions leaks account existence via allowCredentials population

`LOW` · `security` · `passkey` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

BEH-EA-136 makes the verify responses enumeration-safe, but the options endpoint undoes part of that discipline: a posted email yields `allowCredentials` populated only when the account exists, so response size/content distinguishes registered from unregistered emails. The codebase already accepts a uniform InvalidCredentials for unknown emails in the password plugin; the options response has no such uniformity. This is a widely tolerated trade-off in username-first WebAuthn, but it is an inconsistency with the plugin's own stated enumeration posture and costs nothing to mask.

## Evidence

Source: `packages/passkey/src/Passkey.ts:513`

```
const userOpt = yield* users.findByEmail(email);
if (Option.isSome(userOpt)) {
  const owned = yield* credentials.listByUser(userOpt.value.id);
```

## Recommended fix

For unknown emails, return a decoy challenge and an empty-but-shaped response after constant work (or document explicitly in BEH-EA-136 that options are out of the enumeration-safe envelope); at minimum note the trade-off next to the BEH-EA-136 comment in PasskeyApi.ts.

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
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-enumeration-safety`. Duplicate of `TC-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:723`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
