---
ID: "AAPS-009"
Title: "ApiKey/Service principals carry no attribute payload; attribute policies deny them by construction"
Level: info
Category: "architecture"
Status: wontfix
Package: "qadi"
Source: "packages/qadi/src/SubjectResolver.ts:74"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-009 — ApiKey/Service principals carry no attribute payload; attribute policies deny them by construction

`INFO` · `architecture` · `qadi` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **wontfix**

## Summary

ApiKeyPrincipal and ServicePrincipal (packages/api/src/Api.ts:27-33) carry only a ref — no scopes field exists and no producer mints one, so both resolve to identity-only subjects (BEH-EA-140/141 deliberately unimplemented, documented at SubjectResolver.ts:26-39). Any attribute or permission policy evaluated against these subjects resolves undefined and denies, which is correct fail-closed behavior today, but the moment @awthaq/api-key ships there is no reserved, typed location for its scopes to flow into the subject — the same reservation gap as AAPS-006, one principal kind earlier.

## Evidence

Source: `packages/qadi/src/SubjectResolver.ts:74`

```
case "ApiKey":
  return makeSubject({ id: `apikey:${principal.ref.id}` });
case "Service":
```

## Recommended fix

When designing the api-key plugin, add the scopes field to ApiKeyPrincipal and map it into AuthSubject.permissions inside the SubjectResolver override in the same change, keeping one principal-to-attribute mapping point.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-006` — SessionViewExtension slot from ADR-EA-012 never declared; no channel for session trust attributes](medium/AAPS-006-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`RRM-012` — Slot-conflict enforcement lands at layer build, not Auth.make as spec promises](info/RRM-012-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`
- [`SAM-007` — Token claims are write-only: auth.jwt()-based policies have no read path into qadi](medium/SAM-007-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `session-assurance-channel`. Evidence at HEAD ec065a7: `packages/qadi/src/SubjectResolver.ts:74`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.

**Wontfix (2026-09-29):** Overtaken by events rather than a defect. `ApiKeyPrincipal` and `ServicePrincipal` now carry `scopes` (OCM-002, MAPS-003; `packages/api/src/Api.ts`), `@awthaq/api-key` and the client-credentials path populate them, and the qadi `SubjectResolver` maps them to permissions (BEH-EA-140/141). The 'no reserved typed location for scopes' gap the finding predicted no longer exists. A policy that needs more than scopes on a machine caller attaches its own attributes through the subject attribute mapping.
