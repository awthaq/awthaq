---
ID: "MTI-004"
Title: "Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns"
Level: high
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:908"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-004 — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns

`HIGH` · `architecture` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

The plugin declares its seven organization_* tables (Organization.ts:908-916) but sets no migrations option; core/src/Migrations.ts:31 confirms 'no plugin populates migrations yet'. Only the five user-scoped core tables have real migrations (packages/sql/src/CoreMigrations.ts:55-238), and they contain no organization/tenant column anywhere — consistent with plugin-owned tenancy, but it means the entire tenant data model has no shipped schema: no UNIQUE constraints, no foreign keys, no org-key indexes. Tests CREATE TABLE the org tables inline (e.g. organization/test/MembershipRecords.test.ts:22-29), so every deployment and every CI run reinvents the schema by hand. The migration mechanism the codebase already built (Auth.make renumberMigrations + Migrator.run) is sitting unused for exactly the tables tenancy depends on.

## Evidence

Source: `packages/organization/src/Organization.ts:908`

```
    tables: [
      "organization_org",
      "organization_membership",
```

## Recommended fix

Populate the plugin's migrations option with one migration per organization_* table (mirroring CoreMigrations' pg/sqlite branching), including UNIQUE(userId, organizationId) on membership, UNIQUE(organizationId, role) on role, and organizationId indexes; this closes MTI-003's constraint gap and gives MTI-005's indexes a home.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-008` — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check](medium/MTI-008-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `Organization.ts:908-916` (evidence matches) declares the plugin's `AuthPlugin.Service` options with a `tables` list but no `migrations` key. `packages/core/src/Migrations.ts:31` explicitly states "no plugin populates `migrations` yet," and `grep organization packages/sql/src/CoreMigrations.ts` returns nothing — core migrations carry no tenant columns. Tests do inline `CREATE TABLE organization_membership` (`organization/test/MembershipRecords.test.ts:23`). Writing migrations per table, mirroring `CoreMigrations`' pattern, is a well-scoped mechanical task using an already-built runner (`core/src/Migrations.ts`'s `run`). Status → ready-for-agent.

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `org-write-atomicity-and-uniqueness`. Already fixed by commit 58ef46a. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1236`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
