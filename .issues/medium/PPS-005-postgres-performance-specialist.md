---
ID: "PPS-005"
Title: "Plugin tables have no production DDL: index alignment for organization/passkey/admin/jwt tables is absent, not just imperfect"
Level: medium
Category: "performance"
Status: resolved
Package: "organization"
Source: "packages/organization/src/InvitationRecords.ts:246"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-005 — Plugin tables have no production DDL: index alignment for organization/passkey/admin/jwt tables is absent, not just imperfect

`MEDIUM` · `performance` · `organization` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **resolved**

## Summary

A repo-wide grep shows CoreMigrations.ts is the only shipped DDL; every plugin table (organization_org/membership/invitation/role/team/team_membership/active_context, passkey_credential, passkey_challenge, admin_impersonation, jwt_signing_key) is created only inside test setups with raw CREATE TABLE and — organization_org's inline UNIQUE slug excepted — no secondary indexes at all. Queries like the one above (email + organizationId + status) and organization_membership listByUser/countOwners would each be sequential scans at production scale. Core's own migrations show the team knows the fix (migrations 8 and 9 were added precisely because userId filter keys were unindexed), so this is unfinished cutover rather than an oversight in principle.

## Evidence

Source: `packages/organization/src/InvitationRecords.ts:246`

```
sql`SELECT * FROM organization_invitation WHERE email = ${r.email} AND organizationId = ${r.organizationId} AND status = 'pending'`,
```

## Recommended fix

Ship real plugin migrations through the AuthPlugin migrations mechanism (CoreMigrations.ts:16-19 documents the hook) with secondary indexes for every shipped filter key: organization_invitation(email, organizationId, status), organization_membership(userId) and (organizationId), passkey_credential(userId), admin_impersonation(targetUserId), so index alignment is a property of the package rather than of each consumer's hand-written test DDL.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Postgres performance
- Full dossier: [`postgres-performance-specialist`](../../.reports/postgres-performance-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `org-sql-count-queries`. Already fixed by commit 58ef46a. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1077`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → resolved.
