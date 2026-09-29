---
ID: "TTE-009"
Title: "HTTP tests assert against untyped JSON casts instead of contract schemas"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/test/AuthHttp.test.ts:252"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-009 — HTTP tests assert against untyped JSON casts instead of contract schemas

`LOW` · `testing` · `admin` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **ready-for-agent**

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
