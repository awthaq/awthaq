---
ID: "RRC-003"
Title: "qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/OrganizationQadi.ts:97"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-003 — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes

`MEDIUM` · `security` · `organization` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **ready-for-agent**

## Summary

RelationshipResolver.check resolves the "member", "admin", and "owner" relations via organization.attributesFor, which is members.findByUserAndOrg — a plain SELECT against organization_membership (MembershipRecords.ts:260); "team-member" resolves via teams.findTeamMembership, equally bare. The corresponding writes (updateRole's demote-owner-to-member, remove, removeAllForOrganization cascade) commit on the primary with nothing ordering subsequent decision reads after them. Latent today under the single-client topology, but the moment reads are replica-served, a removed or demoted member keeps passing permission checks for the entire replication window — an unbounded, undocumented authorization-revocation latency — while freshly added members face false 403s. The spec's own anti-staleness rule BEH-EA-180 ("A stale decision is not a decision", spec/behaviors/23-react.md:73) exists only as a React-side rendering rule with no server-side counterpart.

## Evidence

Source: `packages/organization/src/OrganizationQadi.ts:97`

```
return yield* organization
                .attributesFor(resourceId, userId)
                .pipe(
```

## Recommended fix

Classify membership and team-membership reads used by decision paths as primary-pinned (or gate them on the membership write's causal token), and document the intended revocation-latency bound in spec/behaviors/21-qadi-resolvers-obligations.md.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: replica consistency
- Full dossier: [`read-replica-consistency-specialist`](../../.reports/read-replica-consistency-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OHS-009` — qadi team-member relation is a flat direct lookup; depth and org implication ignored](info/OHS-009-organization-hierarchy-specialist.md) `_(organization-hierarchy-specialist, info)_`
- [`RZS-001` — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored](high/RZS-001-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, high)_`
- [`RZS-004` — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use](medium/RZS-004-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`RZS-005` — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions](medium/RZS-005-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, medium)_`
- [`SAM-005` — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments](medium/SAM-005-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`
- [`YL-002` — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism](medium/YL-002-yang-luo.md) `_(yang-luo, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `org-qadi-relationships`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationQadi.ts:96`. Fix: When ticket 28's ReadRouting lands (RRC-001), classify every authorization-decision read as primary-pinned and state the revocation-latency bound in the spec. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
