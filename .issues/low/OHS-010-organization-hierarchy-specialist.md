---
ID: "OHS-010"
Title: "README and spec model still claim the package is unimplemented"
Level: low
Category: "docs"
Status: resolved
Package: "organization"
Source: "packages/organization/README.md:3"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-010 — README and spec model still claim the package is unimplemented

`LOW` · `docs` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **resolved**

## Summary

The README asserts no source exists, and spec/models/14-organization.md:25 repeats 'Nothing described here exists yet', while the package ships ~4,600 lines across 11 implemented modules (index.ts exports Organization, TeamRecords, OrganizationQadi, PermissionEngine, and more) with full test suites. The contract requires cross-checking docs against code: this is a stale-docs mismatch that misleads adopters about what they can install, and the README also omits the API surface (config flags, relation vocabulary) entirely.

## Evidence

Source: `packages/organization/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet.
```

## Recommended fix

Refresh README.md and the model doc to implemented status, listing the actual capability set (teams config, dynamic access control, qadi contributions) and its two-level-only scope.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/organization/README.md:3`. Fix: Rewrite the organization README (capability set, config flags, relation vocabulary, HTTP surface) and update the model doc's status paragraph. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/organization/README.md rewritten (capability set, role tiers, OrganizationConfig flags, HTTP surface, persistence/atomicity, relation vocabulary with the depth>=1 / resourceId contract, ResourceOrganizationLookup requirement, erasure tap); spec/models/14-organization.md 'Nothing described here exists yet' replaced with an implemented-status paragraph and deviations. Team scope is documented as flat (hierarchy = OHS-001). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, tests/bdd green apart from load-induced timeouts in password/ports (machine load average ~170 from parallel agents; each green in isolation), spec:verify:strict PASS, oxlint clean.
