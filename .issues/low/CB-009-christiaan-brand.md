---
ID: "CB-009"
Title: "Conditional-create UV exemption is keyed by challenge scope, not by ceremony eligibility"
Level: low
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:461"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-009 — Conditional-create UV exemption is keyed by challenge scope, not by ceremony eligibility

`LOW` · `security` · `passkey` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

The UV skip for Conditional Create is decided purely by which ChallengeStore scope the presented challenge happens to pop from: any authenticated caller can request `register/options/conditional` (same session scoping, config-gated only by a boolean) and thereby register a credential with UP=0/UV=0 even when the browser would happily have performed UV, while an identical ceremony through the ordinary endpoint demands UV (see CB-001). The account binding itself is safe — the caller holds an authenticated session either way — but the effective authentication-strength of new credentials silently depends on which of two sibling endpoints the client chose, and combined with CB-001 the two endpoints enforce opposite UV policies from one config value.

## Evidence

Source: `packages/passkey/src/Passkey.ts:461`

```
enforceUserVerification = false;
```

## Recommended fix

Encode the conditional exemption in the config-driven policy (e.g. a single `expectedUserVerification` computed per ceremony type at options time and stored with, or derived alongside, the challenge) rather than inferring policy from consumption order of two overlapping scopes.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `passkey-ceremony-policy`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:662`. Fix: Make the conditional exemption policy-driven: conditional create is unavailable when the RP requires UV. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Conditional-create UV exemption is policy-driven: registerOptionsConditional answers PasskeyConditionalCreateDisabled when userVerification is 'required', and registerVerify enforces required UV for both ceremonies. Test: PasskeyCeremony.test.ts 'registerOptionsConditional answers PasskeyConditionalCreateDisabled' (red before: options issued). Documented on PasskeyConfig.conditionalCreate and README. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
