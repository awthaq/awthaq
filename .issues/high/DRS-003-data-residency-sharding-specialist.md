---
ID: "DRS-003"
Title: "Zero production migrations exist for all 11 plugin-owned tables — no surface on which residency partitioning could ship"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Migrations.ts:31"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-003 — Zero production migrations exist for all 11 plugin-owned tables — no surface on which residency partitioning could ship

`HIGH` · `architecture` · `core` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **resolved**

## Summary

The org, passkey, admin, and jwt plugins all write real SQL against tables (organization_org, organization_membership, organization_invitation, organization_active_context, organization_role, organization_team, organization_team_membership, passkey_credential, passkey_challenge, admin_impersonation, jwt_signing_key) whose CREATE TABLE statements exist only inside test fixtures (e.g. packages/organization/test/OrganizationRecords.test.ts:20, packages/passkey/test/PasskeyCredentials.test.ts:23). The plugin migration mechanism is built and tested (Auth.ts renumberMigrations, Migrator wiring) but no plugin declares migrations, so production deployments have no DDL for plugin data at all — and per-tenant partitioning, storage-clause placement, or even a plain index addition has no migration lane to arrive through.

## Evidence

Source: `packages/core/src/Migrations.ts:31`

```
migrator's own numeric id; no plugin populates `migrations` yet (the
```

## Recommended fix

Populate each plugin's migrations option with its real dual-dialect DDL following CoreMigrations' onDialectOrElse pattern. This is the prerequisite ticket for everything else in this domain: no tenant column, partition, or tablespace declaration can ship without it.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-001` — None of the 11 plugin tables ships a migration; DDL exists only inside test setup](high/BE-001-bereket-engida.md) `_(bereket-engida, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/Migrations.ts:31` matches the quoted "no plugin populates `migrations` yet" comment verbatim, and a grep for `migrations` across `packages/organization|passkey|admin|jwt/src` returns zero hits; DDL for these tables exists only in test fixtures (e.g. `packages/organization/test/OrganizationRecords.test.ts:20`, sqlite-only). Porting existing test DDL into dual-dialect plugin migrations following `CoreMigrations.ts`'s established `onDialectOrElse` pattern is a well-scoped mechanical task. Status → ready-for-agent.

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `data-retention-sweep`. Already fixed by commit 58ef46a. Evidence at HEAD ec065a7: `packages/core/src/Migrations.ts:33`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
