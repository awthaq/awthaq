---
ID: "TTE-009"
Title: "HTTP tests assert against untyped JSON casts instead of contract schemas"
Level: low
Category: "testing"
Status: resolved
Package: "admin"
Source: "packages/admin/test/AuthHttp.test.ts:252"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-009 — HTTP tests assert against untyped JSON casts instead of contract schemas

`LOW` · `testing` · `admin` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

Test suites across admin/organization/server/passkey cast `response.json()` results (`as ReadonlyArray<unknown>`, `as ReadonlyArray<{id: string}>`) and then assert on lengths. These casts are confined to tests (the src zero-assertion rule is not implicated) but they type-launder wire data exactly like the src findings do, so a contract shape drift that should fail assertions on field values instead passes silently or fails on `undefined` comparisons.

## Evidence

Source: `packages/admin/test/AuthHttp.test.ts:252`

```
const allRows = (yield* Effect.promise(() => all.json())) as ReadonlyArray<unknown>;
```

## Recommended fix

Decode responses through the `@awthaq/api` contract schemas (the same `Schema.decodeUnknown` the server side uses); assertions then run against typed DTOs and shape drift fails loudly at the decode step.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `package-and-test-hygiene`. Evidence at HEAD ec065a7: `packages/admin/test/AuthHttp.test.ts:293`. Fix: Decode HTTP test responses through the contract schemas instead of casting. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** The password, server, organization, passkey and admin AuthHttp suites no longer cast response.json(): each body is decoded with Schema.decodeUnknownSync against the contract class it is served as (SessionContract.SessionDto, AccountContract.AccountDto/AccountExportDto, OrganizationApi.*Dto, PasskeyApi.PasskeyCredentialDto/AuthenticateOptionsResult/PasskeySignalsDto, AdminApi.UserPageDto/ImpersonationPageDto/ConfigItemDto/UserDto), so shape drift fails at the decode step. Keyset cursors are re-encoded with the contract's cursor schemas when paging (exercising them). Raw-wire checks stay on the raw body where decoding would hide the point (the invitation's tokenHash/token absence, MTI-010). The remaining casts in these files are the ReadonlyArray<string> constant for CSRF allowedOrigins, not wire data. Suites green (868 tests), typecheck (tsconfig.test.json) clean.
