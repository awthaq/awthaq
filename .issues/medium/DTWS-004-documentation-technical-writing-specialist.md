---
ID: "DTWS-004"
Title: "Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "README.md:26"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-004 — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment

`MEDIUM` · `docs` · `—` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **ready-for-agent**

## Summary

packages/roles/src/Roles.ts:83 defines a real plugin (`export class Roles extends AuthPlugin.Service<Roles, RolesShape>()("roles", ...)`), and both spec/overview.md:55 and spec/roadmap.md:44 list Roles. Yet the root README's repository map (line 26), the Plugins table (lines 223-231), and even the quickstart's inline comment claiming the 'same call takes [Password, OAuth, Organization, Admin, Passkey, Jwt] unchanged' (line 69) all omit it. The README's plugin inventory — the first thing a user scans — under-reports the shipped surface, and its own example tuple quietly excludes a working plugin.

## Evidence

Source: `README.md:26`

```
and one package per plugin (`password`, `oauth`, `organization`, `admin`, `passkey`, `jwt`, plus stub packages not yet built out
```

## Recommended fix

Add a Roles row to the Plugins table ('roles via a role DAG into qadi's AuthSubject; memory-backed assignments today'), add it to the repository-map plugin list, and include Roles in the line-69 composition comment with a caveat that persistence is layerMemory-only (per Roles.ts:15-19).

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `README.md:26`. Fix: Bring the README's package inventory in line with packages/: add Roles to the repo map, plugin table and composition comment, and list the other unlisted packages (client, react, qadi, migrate-auth0, migrate-better-auth). (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
