---
ID: "AVS-003"
Title: "Untyped `Schema.Unknown` success contracts on passkey register-options endpoints"
Level: medium
Category: "api"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/PasskeyApi.ts:203"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-003 — Untyped `Schema.Unknown` success contracts on passkey register-options endpoints

`MEDIUM` · `api` · `passkey` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

`registerOptions` and `registerOptionsConditional` declare `success: Schema.Unknown`, so the wire shape of the server's most security-sensitive response (WebAuthn creation options) is unspecified in the contract package every client derives from. Consumers get no static type, generated clients decode nothing, and any future tightening of the shape is a silent breaking change with no compiler signal for downstream code — exactly the class of undisciplined contract evolution this library's contract-first design exists to prevent. Every other endpoint in the monorepo (52 total) declares a named Schema class.

## Evidence

Source: `packages/passkey/src/PasskeyApi.ts:203`

```
HttpApiEndpoint.post("registerOptions", "/passkey/register/options", {
      success: Schema.Unknown,
    }),
```

## Recommended fix

Define a `PublicKeyCredentialCreationOptionsDto` Schema class (or a documented pass-through struct) and use it as `success`. If the shape is genuinely provider-dependent, declare that explicitly as a discriminated union or a versioned envelope rather than `Unknown`.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-006` — Two spellings of the DELETE verb and four id conventions for destructive endpoints](low/AVS-006-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, low)_`
- [`BPAS-009` — PasskeyCounterAnomaly declared in the contract but never raised by any endpoint](info/BPAS-009-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, info)_`
- [`HSK-003` — Browser-reported transports are dropped at the API boundary, so the transports column is usually empty](medium/HSK-003-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-wire-contract`. Evidence at HEAD ec065a7: `packages/passkey/src/PasskeyApi.ts:232`. Fix: Model the WebAuthn options dictionaries as Schemas in the contract and use them as success types. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Typed contract: PasskeyApi.PublicKeyCredentialCreationOptionsSchema / PublicKeyCredentialRequestOptionsSchema (WebAuthn L3 members, mutable arrays, optionalKey) replace Schema.Unknown on registerOptions, registerOptionsConditional, reauthenticateOptions and AuthenticateOptionsResult.options; Passkey.ts decodes the port's output through them (Schema.decodeUnknownEffect + orDie, no casts; the port now omits an undefined `extensions` member); the client's isCreationOptionsJSON/isRequestOptionsJSON guards are deleted and the typed options go straight to startRegistration/startAuthentication. Tests: AuthHttp.test.ts 'the OpenAPI document declares a structured schema for the options endpoints'; client tests now expect SchemaError for malformed options. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
