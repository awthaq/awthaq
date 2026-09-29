---
ID: "SAM-005"
Title: "No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments"
Level: medium
Category: "docs"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationQadi.ts:12"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-005 — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments

`MEDIUM` · `docs` · `organization` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **resolved**

## Summary

Re-modeling RLS is the core Supabase migration job, and the repo's knowledge about what qadi can and cannot express lives in a ticket-correction comment: AttributeResolver has no resourceId, resource facts are an inline data bag passed per evaluate call, and org-scoped questions must route through RelationshipResolver. A typical policy like USING (auth.uid() = user_id OR EXISTS (... org_members ... role = 'admin')) decomposes cleanly (row ownership via the resource bag; the org disjunct via the organization plugin's relationship resolver), but nowhere does the repo say so. spec/ contains zero RLS mentions (grep confirms), and no policy-catalog-first method exists despite that being the discipline the whole migration hinges on.

## Evidence

Source: `packages/organization/src/OrganizationQadi.ts:12`

```
 * `@qadi/core` API this ticket builds against**: `AttributeResolverShape.resolve`
 * is `(subjectId, attribute) => Effect<unknown, AttributeResolveError>` —
 * it carries no `resourceId` at all.
```

## Recommended fix

Write the RLS-to-qadi migration guide: catalog every policy as a plain-language rule first; map row-ownership USING clauses to EvaluateOptions.resource checks; map membership/role disjuncts to the organization plugin's relationships; and state explicitly which Supabase policy shapes (e.g. SECURITY DEFINER helpers, storage.objects prefixes) have no direct equivalent.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-009` — qadi team-member relation is a flat direct lookup; depth and org implication ignored](info/OHS-009-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, info)_`
- [`RRC-003` — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes](medium/RRC-003-read-replica-consistency-specialist.md) `_(read-replica-consistency-specialist, medium)_`
- [`RZS-001` — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored](high/RZS-001-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, high)_`
- [`RZS-004` — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use](medium/RZS-004-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`RZS-005` — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions](medium/RZS-005-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`YL-002` — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism](medium/YL-002-yang-luo.md) `_(yang-luo, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationQadi.ts:11`. Fix: Write the RLS→qadi migration guide as a spec appendix. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New spec/appendices/04-rls-to-qadi-migration.md (registered in appendices/index.yaml): policy-catalog-first method, RLS-term -> qadi/awthaq mapping table (auth.uid ownership, org membership/role EXISTS, per-org permissions, auth.jwt claims, anon), unsupported shapes (SECURITY DEFINER helpers, storage.objects prefixes) with workarounds, SQL pushdown for list queries (BEH-EA-166), and a worked members-read/editors-update project example using ResourceOrganizationLookup + has-role/`member:update`. spec:verify:strict passes with it registered. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, tests/bdd green apart from load-induced timeouts in password/ports (machine load average ~170 from parallel agents; each green in isolation), spec:verify:strict PASS, oxlint clean.
