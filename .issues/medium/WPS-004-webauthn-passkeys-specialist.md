---
ID: "WPS-004"
Title: "Plugin sets the session cookie itself, contradicting BEH-EA-131 and un-skipped scenario REQ-EA-362"
Level: medium
Category: "compliance"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:317"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-004 — Plugin sets the session cookie itself, contradicting BEH-EA-131 and un-skipped scenario REQ-EA-362

`MEDIUM` · `compliance` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **resolved**

## Summary

BEH-EA-131's REQUIREMENT states "the passkey plugin MUST NOT set a session cookie itself", and feature scenario REQ-EA-362 (features/features/05-authentication-methods/17-passkey.feature:87-91, not @skip) asserts "the session cookie is set by core Sessions, not by any cookie-setting code in the passkey plugin". The handler does exactly what both forbid. The session itself does come from core Sessions (so expiry/rotation semantics are uniform), and @awthaq/password repeats the same pattern, which suggests the spec text lags an agreed delivery convention — but as written, shipped behavior and behavior spec diverge on a security-relevant delivery step in both plugins.

## Evidence

Source: `packages/passkey/src/Passkey.ts:317`

```
yield* HttpApiBuilder.securitySetCookie(
  Api.SessionCookie,
  Redacted.value(issued.token),
```

## Recommended fix

Either move post-authentication cookie delivery into a shared core/server mechanism (e.g. the existing PostAuthResponseHook-style slot) and update both plugins, or amend BEH-EA-131/REQ-EA-362 to document that the HTTP boundary layer sets the cookie using core's SessionCookie/SESSION_COOKIE_ATTRIBUTES.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-delivery`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:362`. Fix: Introduce one shared session-delivery helper (owned by @awthaq/api/server, implementing ticket 17's cookie-or-bearer choice) and route every session-minting handler through it; amend BEH-EA-131 accordingly. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Plan note (2026-09-29, P08):** left open. P08 (passkey) kept its own `securitySetCookie` in the `authenticateVerify` handler untouched (`packages/passkey/src/Passkey.ts`, handler group `passkey.authenticate`); moving it to the shared session-delivery abstraction belongs to P16/`session-delivery`. When that lands, the passkey handler only needs to swap its cookie call for the shared helper. P08 also made `authenticateVerify`'s handler receive the resolved client address (via `ClientAddress`), which is the natural place for the delivery context.

**Resolved (2026-09-29):** Session delivery is one shared helper: @awthaq/server SessionDelivery (mode + deliver, see MNA-001). Password (signUp/signIn/changePassword) and Passkey (authenticateVerify) no longer call SessionCookie.set themselves (grep: no plugin src writes the session cookie directly except admin's impersonation-kind cookie). BEH-EA-131 reworded ('MUST deliver only through the shared SessionDelivery helper'); features REQ-EA-362 scenario/step text updated to match (still asserts the __Host-session cookie in default mode). Test: packages/passkey/test/AuthHttp.test.ts 'WPS-004: authenticate/verify with X-Awthaq-Token-Delivery: bearer returns the token and sets no cookie' (unknown value 400 without consuming the ceremony). Gates as MNA-001.
