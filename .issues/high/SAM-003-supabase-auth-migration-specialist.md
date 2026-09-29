---
ID: "SAM-003"
Title: "User model cannot represent anonymous or phone-only Supabase users"
Level: high
Category: "correctness"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/CoreMigrations.ts:61"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-003 — User model cannot represent anonymous or phone-only Supabase users

`HIGH` · `correctness` · `sql` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

Supabase auth.users rows may have NULL email (anonymous sign-ins) or phone-only identity (SMS OTP), but effect-auth requires a non-null email everywhere: the domain create signature takes { email, name } (packages/core/src/Users.ts:56-59), the model declares email: Schema.String (packages/sql/src/Models.ts:42), and the DDL enforces NOT NULL. There is no phone field anywhere in the repo (repo-wide grep returns zero phone auth support). Migrating such users requires fabricating placeholder emails that then collide against the UNIQUE lower(email) index (packages/sql/src/CoreMigrations.ts:215) or dropping the population outright — silent data loss if unnoticed.

## Evidence

Source: `packages/sql/src/CoreMigrations.ts:61`

```
email TEXT NOT NULL,
"emailVerified" BOOLEAN NOT NULL,
```

## Recommended fix

Before 1.0, widen the User model: make email nullable (or introduce an explicit identifier union), add phone/phoneVerified columns, and define sign-in eligibility independently of email verification so identity-less populations remain representable and migratable.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-010` — No retention policy or mechanism exists for any audit data](low/ALF-010-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CSG-009` — No residency, region, or subprocessor hooks; data location is undocumented deployer choice](info/CSG-009-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, info)_`
- [`DRS-001` — No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change](high/DRS-001-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`PPS-002` — Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set](medium/PPS-002-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`
- [`PPS-009` — jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres](info/PPS-009-postgres-performance-specialist.md) `_(postgres-performance-specialist, info)_`
- [`SSMS-006` — Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations](low/SSMS-006-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, low)_`
- [`SSMS-009` — No tenant column anywhere in the core schema](info/SSMS-009-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, info)_`
- [`SEA-006` — Keyset pagination orders by (createdAt, id) but only a single-column userId index exists](low/SEA-006-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — CoreMigrations.ts:61 (`email TEXT NOT NULL`) matches, Users.ts's `create` signature requires `{email, name}`, Models.ts:42 has `email: Schema.String` non-nullable, and a repo-wide grep for "phone" across `packages/` returns zero matches. Widening the identity model (nullable email, phone column, sign-in-eligibility redefinition) is a schema/product decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [UserRecord model extension (optional email, phone/anonymous identity, deactivation state)](../../.scratch/resolve-ready-for-human-findings/issues/09-userrecord-model-extension.md) — `email`/`phone` become nullable columns folded into a `UserIdentity` tagged union at the domain layer, with a new `phone`/`phoneVerified`/unique-index migration sequence (ids 10-12) and dialect-specific SQLite table-rebuild handling for `DROP NOT NULL`. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `user-identity-lifecycle`. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:58`. Fix: Implement ticket 09's decision: a `UserIdentity` tagged union (Email | Phone | Anonymous) at the domain layer, flattened to nullable email/phone columns plus phoneVerified in SQL, with a `promoteIdentity` upgrade path. Ticket 09's migration ids 10-12 are already taken; use the next free ids. (effort XL). Full dossier: `.plan/slices/05-sql.md`.
