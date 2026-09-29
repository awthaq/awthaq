---
ID: "AAPS-008"
Title: "SubjectDto exposes only subject-embedded attributes, hiding resolver-resolved ones from clients"
Level: low
Category: "dx"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/SubjectApi.ts:55"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-008 — SubjectDto exposes only subject-embedded attributes, hiding resolver-resolved ones from clients

`LOW` · `dx` · `qadi` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

The /subject whoami handler serializes `subject.attributes` verbatim, which after both resolvers contains at most `actingAs` — emailVerified, name and the org counts are resolved lazily by qadi's AttributeResolver during policy evaluation and never appear on the wire. A React client gating UI on the subject DTO therefore sees a different attribute set than the server's policies evaluate, and cannot replicate even a read-only `emailVerified` check without a second source. The split is a consequence of the resolver's per-check design, but it is undocumented on the DTO.

## Evidence

Source: `packages/qadi/src/SubjectApi.ts:55`

```
attributes: subject.attributes,
```

## Recommended fix

Either resolve the standard subject-scoped attributes into the DTO at handler time (the handler can call the AttributeResolver it already has in scope) or document SubjectDto.attributes as "embedded-only; resolver attributes are server-side" in the schema description.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`YL-004` — Zero enforcement wired anywhere: no endpoint in the repo uses RequirePermission](medium/YL-004-yang-luo.md) `_(yang-luo, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/src/SubjectApi.ts:50`. Fix: Let the subject endpoint resolve a configured set of resolver-backed attributes into the DTO, and document the split. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** SubjectApiConfig (Context.Reference, exposedAttributes default []) + SubjectApi.config([...]); the GET /subject handler resolves each exposed attribute not already embedded through AttributeResolver into the DTO (missing resolver or a resolver failure is a 5xx defect, an undefined value is omitted); SubjectDto.attributes documented in @awthaq/api. Tests: SubjectApi.test.ts 'SubjectApi exposedAttributes (AAPS-008)' x3. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 915 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
