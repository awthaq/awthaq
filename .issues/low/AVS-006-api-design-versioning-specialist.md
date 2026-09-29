---
ID: "AVS-006"
Title: "Two spellings of the DELETE verb and four id conventions for destructive endpoints"
Level: low
Category: "api"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/PasskeyApi.ts:257"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-006 — Two spellings of the DELETE verb and four id conventions for destructive endpoints

`LOW` · `api` · `passkey` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

The same operation is expressed four ways across the contract packages: `make("DELETE")("remove", ...)` (passkey), `delete("delete", "/organization/:organizationId")` (organization), `delete("deleteUser", "/user")` (account), and `delete("removeMember", ...)` (organization). The verb-helper drift (`make("DELETE")` vs the `delete` constructor used everywhere else) is purely mechanical but signals absent convention; the id drift (`remove`/`delete`/`deleteUser`/`removeMember`) leaks into generated client method names, where it becomes consumer-visible API that is costly to normalize later.

## Evidence

Source: `packages/passkey/src/PasskeyApi.ts:257`

```
HttpApiEndpoint.make("DELETE")("remove", "/passkey/credentials/:id", {
```

## Recommended fix

Standardize on the `HttpApiEndpoint.delete(...)` constructor and one id scheme for destructive endpoints (recommendation: resource-action form like `removeMember`, never a bare duplicated verb like `delete`), applied in a single cosmetic sweep before first publish while it is still free.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-003` — Untyped `Schema.Unknown` success contracts on passkey register-options endpoints](medium/AVS-003-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`BPAS-009` — PasskeyCounterAnomaly declared in the contract but never raised by any endpoint](info/BPAS-009-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, info)_`
- [`HSK-003` — Browser-reported transports are dropped at the API boundary, so the transports column is usually empty](medium/HSK-003-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-wire-contract`. Evidence at HEAD ec065a7: `packages/passkey/src/PasskeyApi.ts:310`. Fix: Use HttpApiEndpoint.delete and a resource-action id for the passkey credential delete. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** PasskeyApi uses HttpApiEndpoint.delete and one resource-action id scheme (listCredentials/renameCredential/removeCredential/signals); handlers and client updated. Typecheck plus the existing AuthHttp DELETE test are the proof. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
