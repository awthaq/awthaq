---
ID: "BPAS-009"
Title: "PasskeyCounterAnomaly declared in the contract but never raised by any endpoint"
Level: info
Category: "api"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/PasskeyApi.ts:116"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-009 — PasskeyCounterAnomaly declared in the contract but never raised by any endpoint

`INFO` · `api` · `passkey` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **resolved**

## Summary

The counter-regression policy is deliberately log-not-kill (Passkey.ts:581-594 publishes auth.passkey.counterAnomaly and still issues the session — the correct posture for cloud-synced and Touch-ID always-zero counters), and the BDD suite flags the divergence honestly (17-passkey.feature:247-260). The type stays in BEH-EA-136's closed error list purely for future policy changes, but as shipped it is a branch clients can catchTag for that can never occur — a small honesty tax on the typed-error surface.

## Evidence

Source: `packages/passkey/src/PasskeyApi.ts:116`

```
export class PasskeyCounterAnomaly extends Schema.TaggedError<PasskeyCounterAnomaly>()(
  "PasskeyCounterAnomaly",
  {},
```

## Recommended fix

Either remove it from the contract until a policy change needs it, or annotate the doc comment to state explicitly that no current endpoint raises it (the BDD file's reasoning is the right text).

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-003` — Untyped `Schema.Unknown` success contracts on passkey register-options endpoints](medium/AVS-003-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`AVS-006` — Two spellings of the DELETE verb and four id conventions for destructive endpoints](low/AVS-006-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, low)_`
- [`HSK-003` — Browser-reported transports are dropped at the API boundary, so the transports column is usually empty](medium/HSK-003-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-counter-anomaly-policy`. Duplicate of `WPS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/PasskeyApi.ts:133`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `WPS-006-webauthn-passkeys-specialist` — closed by its fix (see that issue's Resolved comment).
