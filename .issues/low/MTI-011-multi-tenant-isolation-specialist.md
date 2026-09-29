---
ID: "MTI-011"
Title: "No adversarial cross-tenant test suite; the BDD suite has no organization feature at all"
Level: low
Category: "testing"
Status: resolved
Package: "—"
Source: "features/README.md:9"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-011 — No adversarial cross-tenant test suite; the BDD suite has no organization feature at all

`LOW` · `testing` · `—` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

The record-level tests do assert cross-org filtering per method (e.g. OrgRoleRecords.test.ts:108-112 creates org-a/org-b roles and counts org-a), and Organization.test.ts tests outsider permission denials at the service level. But nothing attempts the persona's isolation suite: two composed tenants, every read and write attempted across the boundary, failing the build on any leak. The 27-scenario impersonation feature (features/features/09-admin-and-impersonation/27-admin-impersonation.feature) contains no cross-tenant scenario, and there is no organization .feature file despite the plugin being the largest implemented surface. Findings MTI-001/002/008 (open reads) would each have been caught by such a suite.

## Evidence

Source: `features/README.md:9`

```
One `.feature` file per `spec/behaviors/NN-*.md` file (26 total), grouped into 9 directories under `features/features/` that mirror the same stratification
```

## Recommended fix

Add an organization BDD feature plus an adversarial isolation suite (tenant A principal vs every tenant B endpoint and records-layer method, asserting denial or empty results, including SQL-backed layers); include a scenario asserting an impersonated admin sees only the target user's tenants.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-006` — Suite self-description is stale: README and STYLE claim pre-implementation with no runner](medium/AH-006-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`BDD-006` — README's pre-implementation claims contradict the wired suite it introduces](medium/BDD-006-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-organization-feature`. Evidence at HEAD ec065a7: `features/README.md:9`. Fix: Author spec/behaviors/28-organization.md (BEH-EA-221..228) from spec/models/14-organization.md, a matching 10-organization/28-organization.feature covering lifecycle (owner invariant, invitation expire/re-invite/cancel, limits, DAC escalation guard, active context) plus an adversarial cross-tenant Rule, and wire it with OrganizationWorld/OrganizationSteps. (effort L). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: spec/behaviors/31-organization.md (BEH-EA-258..265) and features/features/10-organization/31-organization.feature (62 scenarios, 61 run) with an adversarial cross-tenant Rule. Wiring found and fixed a real existence oracle (PV-300): leave and the team endpoints answered a non-member differently for an existing organization than for an unknown id. The impersonating-admin scenario stays skipped: nothing composes admin with organization today.
