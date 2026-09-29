---
ID: "AAPS-003"
Title: "Attribute contract is stringly-typed end to end"
Level: medium
Category: "api"
Status: resolved
Package: "api"
Source: "packages/api/src/Subject.ts:51"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-003 — Attribute contract is stringly-typed end to end

`MEDIUM` · `api` · `api` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

The persona-relevant contract between attribute producer and evaluator is untyped: AttributeResolverShape.resolve takes `(subjectId, attribute: string)` and returns `Effect<unknown>` (@qadi/core AttributeResolver.ts:52-55), AuthSubject.attributes is `Readonly<Record<string, unknown>>`, and the SubjectDto wire shape re-declares that bag. Policy authors reference attribute names as bare strings with no shared schema with the producer; a typo (`emailVerifed`) resolves undefined, and the matcher reports "has no value" — indistinguishable from a legitimately absent attribute, pointing the debugger at wiring rather than spelling. The SubjectResolver/roles half of the contract (typed Role/PermissionKey, exclusive slot) shows the codebase knows how to do better.

## Evidence

Source: `packages/api/src/Subject.ts:51`

```
attributes: Schema.Record(Schema.String, Schema.Unknown),
```

## Recommended fix

Publish a const-keyed attribute-name registry per producer (e.g. `UserAttributeName = "email" | "emailVerified" | "name"`) with a Schema per value, and type the SubjectDto attributes record against it; keep the resolver signature permissive but give consumers a typed façade.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `qadi-attribute-typing`. Evidence at HEAD ec065a7: `packages/api/src/Subject.ts:47`. Fix: Add typing on the producer and evaluator side (in @awthaq/qadi and ../qadi). The isomorphic SubjectDto stays an open record, because its attribute set depends on the composition. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Producer/evaluator-side typing in awthaq: Resolvers.UserAttributeSchemas (a schema per name) with derived UserAttributeName / UserAttributeNames (Record.keys) / userAttr(name) and compiler-enforced per-name readers; OrganizationQadi.OrganizationAttributeSchemas/OrganizationAttributeName/OrganizationAttributeNames/orgAttr likewise. A policy typo against a known producer (userAttr('emailVerifed')) is a compile error. SubjectDto.attributes stays an open record. Tests: Resolvers.test.ts 'typed user attribute names (AAPS-003)' x3 incl. @ts-expect-error. NOT DONE (upstream, outside the plan's allowed ../qadi edits): the evaluator's distinct 'unknown attribute name' diagnostic for a policy naming an attribute no registered resolver declares — a hand-typed string can still typo silently at runtime. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 929 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
