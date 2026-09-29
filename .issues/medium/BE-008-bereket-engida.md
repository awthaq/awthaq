---
ID: "BE-008"
Title: "Hook veto aborts are converted to defects, crashing the request instead of denying it"
Level: medium
Category: "dx"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationHooks.ts:16"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-008 — Hook veto aborts are converted to defects, crashing the request instead of denying it

`MEDIUM` · `dx` · `organization` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

The rationale (avoid threading a new error through 15 endpoints) is understandable, but the ergonomics are wrong: a legitimate application veto — quota reached, compliance policy, moderation rule — becomes an untyped defect (HTTP 500) rather than a graceful denial. In better-auth, a before-hook returning false aborts the operation cleanly. An app author tapping organization.create.before to enforce a policy takes down the request instead of refusing it, and can't distinguish 'my veto' from a crash in monitoring.

## Evidence

Source: `packages/organization/src/OrganizationHooks.ts:16`

```
// an abort is converted to a defect (`Effect.orDie`) right where the veto
// runs, inside `Organization.ts`'s own operation — never propagated as a
// typed `OrganizationShape`/`OrganizationApi` contract error.
```

## Recommended fix

Map HookAbort to a typed contract error — a single shared PluginAborted (403/422 with the hook point id as payload) added once per plugin surface beats orDie; alternatively provide a config flag per plugin choosing abort-as-error vs abort-as-defect.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`JH-009` — No authoring guide or template plugin — conventions live in code comments and test fixtures](low/JH-009-jared-hanson.md) `_(jared-hanson, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit c648000. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1312`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
