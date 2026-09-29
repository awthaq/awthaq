---
ID: "CB-004"
Title: "Counter-anomaly \"log + step-up\" policy is unreachable — library hard-fails regressions first"
Level: medium
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:585"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-004 — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first

`MEDIUM` · `correctness` · `passkey` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

The plugin documents BEH-EA-131's "log + step-up, not an instant kill" and publishes `auth.passkey.counterAnomaly` instead of failing. But SimpleWebAuthn v14's `verifyAuthenticationResponse` throws `Response counter value X was lower than expected Y` whenever `(counter > 0 || credential.counter > 0) && counter <= credential.counter`; the port wraps that throw into PasskeyVerificationFailed and the handler collapses it into Api.InvalidCredentials before the counterRegressed branch can run. The only regression shape that reaches the branch is 0<=0, which the carve-out excludes — so `auth.passkey.counterAnomaly` can never fire. Worse, the plugin's stated policy (never fail the ceremony on regression) is inverted in reality: non-zero regressions hard-fail sign-in with a generic error, silently contradicting both the code comment and the spec's intent.

## Evidence

Source: `packages/passkey/src/Passkey.ts:585`

```
const counterRegressed =
  verified.newCounter <= stored.counter &&
  !(verified.newCounter === 0 && stored.counter === 0);
```

## Recommended fix

Pick one policy and implement it for real: either keep the library's hard-fail and delete the dead branch plus fix the comment/spec, or catch the counter-regression failure mode (inspect the port error) and route it through the anomaly event plus recordUsage with the observed counter, per BEH-EA-131 as written.

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
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-counter-anomaly-policy`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:796`. Fix: Move counter-regression detection out of the library into the plugin so the decided 'log + step-up' policy actually runs, with an optional strict mode. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Counter policy moved into the plugin: port verifyAuthentication passes the library a stored counter of 0 (StoredCredential.counter removed from the port) and reports newCounter; PasskeyConfig.counterAnomalyPolicy 'flag'|'reject' (default flag); regression check shared by authenticateVerify and reauthenticateVerify; PasskeyCounterAnomaly added to both error unions and raised under reject; PasskeyCredentials.recordUsage never lowers the stored counter. Tests: ports WebAuthn.test.ts (regressed assertion verifies with its newCounter), PasskeyCounterAnomaly.test.ts, and PasskeyRealPort.test.ts (real regressed assertion flagged + audited under flag, PasskeyCounterAnomaly under reject; red before: PasskeyVerificationFailed/InvalidCredentials). BDD: REQ-EA-381 un-skipped as a flag|reject Scenario Outline. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
