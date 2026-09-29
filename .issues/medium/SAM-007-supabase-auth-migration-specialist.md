---
ID: "SAM-007"
Title: "Token claims are write-only: auth.jwt()-based policies have no read path into qadi"
Level: medium
Category: "architecture"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/SubjectResolver.ts:52"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-007 — Token claims are write-only: auth.jwt()-based policies have no read path into qadi

`MEDIUM` · `architecture` · `qadi` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **resolved**

## Summary

In Supabase, the JWT is the authorization carrier: policies call auth.jwt() to read custom claims minted by custom_access_token_hook. effect-auth inverts this. The jwt plugin's definePayload hook (packages/jwt/src/Jwt.ts:238-242) is a faithful replacement for minting claims, but on the way back in, the default SubjectResolver maps every principal to an id-only qadi subject — bearer-token claims are never projected into AuthSubject attributes. A migration that ports claim-dependent policy logic verbatim will find the claims unreadable at decision time; authorization facts must instead be resolved from the database (the Roles plugin flattens role assignments into permissions; the Organization plugin resolves memberships), which is the right long-term model but a real semantic translation, not a port.

## Evidence

Source: `packages/qadi/src/SubjectResolver.ts:52`

```
 * BEH-EA-137: `id` only, no roles, no permissions — for every principal kind,
```

## Recommended fix

Document the asymmetry explicitly in the jwt and qadi package docs: claims minted via definePayload authenticate but do not authorize; anything a Supabase policy read from auth.jwt() must be re-homed into a DB-resolved subject attribute (Roles/Organization resolvers or an application SubjectResolver override).

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-006` — SessionViewExtension slot from ADR-EA-012 never declared; no channel for session trust attributes](medium/AAPS-006-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`AAPS-009` — ApiKey/Service principals carry no attribute payload; attribute policies deny them by construction](info/AAPS-009-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, info)_`
- [`RRM-012` — Slot-conflict enforcement lands at layer build, not Auth.make as spec promises](info/RRM-012-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/qadi/src/SubjectResolver.ts:52`. Fix: Document that JWT claims authenticate but do not authorize, and where claim-driven policy logic must be re-homed. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/jwt/README.md and packages/qadi/README.md state that JWT claims authenticate but do not authorize (definePayload claims are not projected into AuthSubject; the default resolver is identity-only) and where auth.jwt()-style facts must be re-homed (Roles, organization relations, AttributeResolver, own SubjectResolver override); cross-linked from the RLS appendix. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, tests/bdd green apart from load-induced timeouts in password/ports (machine load average ~170 from parallel agents; each green in isolation), spec:verify:strict PASS, oxlint clean.
