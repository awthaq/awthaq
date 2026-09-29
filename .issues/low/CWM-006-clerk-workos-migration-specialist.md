---
ID: "CWM-006"
Title: "Organization plugin has no BDD feature file — the deepest plugin's lifecycle contract is specified only by unit tests and code"
Level: low
Category: "testing"
Status: resolved
Package: "—"
Source: "features/traceability.md:474"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-006 — Organization plugin has no BDD feature file — the deepest plugin's lifecycle contract is specified only by unit tests and code

`LOW` · `testing` · `—` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **resolved**

## Summary

The features/ suite covers 27 numbered behaviors but has no organization-lifecycle feature: organization appears in Gherkin only through its qadi resolver obligations (BEH-EA-162 scenarios in 21-qadi-resolvers-obligations.feature, referenced at traceability.md:474). Meanwhile the plugin ships 13 unit/integration test files (~2,850 lines) covering invitations, teams, roles, hooks, and HTTP. For a migration auditor the BDD suite is the executable statement of the contract being migrated to — invitation expiry/re-invite semantics, the owner invariant, DAC escalation guard, and active-context behavior are exactly the subtle rules a Clerk org data migration must preserve, and they currently live only in TypeScript tests rather than the repo's normative behavioral vocabulary.

## Evidence

Source: `features/traceability.md:474`

```
| REQ-EA-454 | [BEH-EA-162](../spec/behaviors/21-qadi-resolvers-obligations.md#beh-ea-162-relationships-resolved-from-organization-membership)                                                                                           | [06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.feature](features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.feature) |
```

## Recommended fix

Add an organization lifecycle feature file (28-organization.feature) encoding the owner invariant, invitation expiry/re-invite/cancel transitions, membership and team limits, and dynamic-role escalation guard as scenarios; the step-definitions harness (PasswordWorld/SessionWorld pattern) already has the shapes needed.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-010` — Traceability manifest stale: 602/26 documented vs 627 tags in 27 spec files](info/AH-010-aslak-hellesoy.md) `_(aslak-hellesoy, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bdd-organization-feature`. Duplicate of `MTI-011` — closed by that issue's fix. Evidence at HEAD ec065a7: `features/traceability.md:474`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
