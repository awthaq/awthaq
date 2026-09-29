---
ID: "CB-003"
Title: "clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies"
Level: medium
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:101"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-003 — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies

`MEDIUM` · `security` · `passkey` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

`ClientDataSchema` reads only type/challenge/origin, so `clientData.crossOrigin` is silently ignored (Effect Schema ignores excess properties), and SimpleWebAuthn v14.0.1 contains no crossOrigin check either (grep of its verify responses shows none). When a top-level page embeds the RP origin in an iframe granted `allow="publickey-credentials-create; publickey-credentials-get"`, clientDataJSON carries the RP's own allowed origin with crossOrigin=true, and this RP verifies the ceremony as if it were first-party. WebAuthn L3 surfaces crossOrigin precisely so relying parties that do not support embedded use can reject such ceremonies.

## Evidence

Source: `packages/passkey/src/Passkey.ts:101`

```
type: Schema.String,
challenge: Schema.String,
origin: Schema.String,
```

## Recommended fix

Add `crossOrigin: Schema.optional(Schema.Boolean)` to ClientDataSchema and fail the ceremony (PasskeyChallengeInvalid or a dedicated error) whenever crossOrigin is present and true, unless/until an explicit embedded-iframe feature policy is added to PasskeyConfig.

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
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `passkey-ceremony-policy`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:113`. Fix: Reject cross-origin ceremonies in the plugin pre-check for all three ceremonies unless an explicit embedded-origin policy is configured. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Cross-origin ceremonies: ClientDataSchema reads crossOrigin/topOrigin; new PasskeyConfig.allowedTopOrigins (default []); one shared checkOrigin refuses crossOrigin:true unless topOrigin is allowed, for registration, sign-in (collapsed to InvalidCredentials) and step-up; expectedTopOrigin is forwarded to the port when configured. Tests: PasskeyCeremony.test.ts (register, register without topOrigin, authenticate, reauthenticate rejected; allowed top origin accepted and forwarded; none forwarded otherwise) and ports WebAuthn.test.ts (expectedTopOrigin). BEH-EA-133 updated. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
