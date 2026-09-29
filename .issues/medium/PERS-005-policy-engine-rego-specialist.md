---
ID: "PERS-005"
Title: "Organization authorization bypasses the declarative policy layer — two parallel deny semantics"
Level: medium
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1040"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-005 — Organization authorization bypasses the declarative policy layer — two parallel deny semantics

`MEDIUM` · `architecture` · `organization` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **resolved**

## Summary

The organization plugin authorizes through an imperative stack — config predicates, its own statement-based PermissionEngine, and requirePermission over qadi resolvers — plus imperative veto taps; none of it produces a qadi Policy, Trace, DecisionRecord, obligation, or DecisionSink entry. @qadi/core's entire auditability advantage (trace trees, renderTrace, decision sinks, decision cache keyed on full grants) is unreachable from the plugin layer, and the two mechanisms disagree on denial shape: qadi denials are typed AccessDenied with obligations, hook denials are defects (see PERS-001). This is exactly the class of cross-cutting policy (org admin scoping, escalation guards) my persona would expect to be expressible declaratively and auditable uniformly.

## Evidence

Source: `packages/organization/src/Organization.ts:1040`

```
const allowed = yield* orgConfig.allowUserToCreateOrganization(callerId);
```

## Recommended fix

Expose at least one Policy-valued hook point (or wire OrganizationQadi's permission checks through qadi's decide/enforce with a DecisionSink), so plugin-layer authorization decisions land in the same trace/audit pipeline as engine-level ones.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Policy Extension Points
- Full dossier: [`policy-engine-rego-specialist`](../../.reports/policy-engine-rego-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `org-qadi-relationships`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1308`. Fix: Keep the self-contained engine (design decision) but make its decisions auditable: publish a denial event into the durable AuditLog, and let qadi evaluate the same statements via RZS-006's permission relations. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** core AuthEvents gains auth.organization.permissionDenied {organizationId, userId, resource, action, reason: notMember|missingStatement} and AuditLog.actorOf its case (compile-enforced); Organization.requirePermission publishes it on both denial branches before failing (requireMembership read-only denials are not PermissionEngine denials and are not published). The qadi half (evaluating the same statements declaratively so qadi traces/DecisionSinks see them) is RZS-006's <resource>:<action> relations. Tests: Organization.test.ts 'permission denials are audited (PERS-005)' x2, core AuditLog.test.ts both layers. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 896 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
