---
ID: "SSMS-001"
Title: "jwt_signing_key has no production migration; layerSql writes to a table only tests create"
Level: high
Category: "correctness"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:172"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-001 — jwt_signing_key has no production migration; layerSql writes to a table only tests create

`HIGH` · `correctness` · `jwt` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

The Jwt plugin declares jwt_signing_key and its SigningKeyRecords.layerSql runs a real INSERT into it (packages/jwt/src/SigningKeyRecords.ts:176), but the plugin options pass no migrations and AuthPlugin.Service defaults them to empty (packages/core/src/AuthPlugin.ts:145: options.migrations ?? []). The only CREATE TABLE for the live key store is in the test suite (packages/jwt/test/KeyRing.test.ts:27). Deploying @awthaq/jwt with layerSql against a real database therefore fails on the first lazy key mint with a missing-relation error - the rotation machinery has no deployable persistence outside tests. The migration mechanism it should use (Migrations.run plus Auth.ts's dependency-ordered renumberMigrations) exists and is proven by the Ping test plugin (packages/core/test/AuthPlugin.test.ts:31-32), so this is a shipping gap, not a missing capability.

## Evidence

Source: `packages/jwt/src/Jwt.ts:172`

```
tables: ["jwt_signing_key"],
```

## Recommended fix

Declare the dual-dialect CREATE TABLE jwt_signing_key (kid PK, alg, publicKeyJwk, privateKeyJwk, createdAt, rotatedAt, retiresAt; plus a partial index on rotatedAt IS NULL) on the Jwt plugin's migrations option, following CoreMigrations' onDialectOrElse pattern; do the same for the other 10 plugin-declared tables.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — Jwt.ts:172 `tables: ["jwt_signing_key"]` matches, with no `migrations` option passed anywhere in Jwt.ts, so `AuthPlugin.ts`'s `options.migrations ?? []` default applies; only packages/jwt/test/KeyRing.test.ts:27 creates the table, via a manual `CREATE TABLE`. Adding the DDL following `CoreMigrations`' `onDialectOrElse` pattern is mechanical. Status → ready-for-agent.

**Resolved (2026-09-19):** The core defect (no production migration for `jwt_signing_key`) was already closed as a side effect of the TIR-001/TRBS-001/MAPS-002 work earlier in this effort — that cluster needed to design `Jwt`'s first-ever `migrations` array anyway (for the new `jwt_token_revocation` table) and included `create_jwt_signing_key` in it (`Jwt.ts`'s `jwtMigrations`, wired via the `migrations:` option), closing this exact gap in passing. Verified genuinely fixed via `RevocationStore.test.ts`'s `Jwt.Jwt.migrations` test, which runs the migrations against a fresh SQLite database and does a real `SELECT` against both tables.

This pass added the one piece the recommended fix called for that wasn't yet covered: a partial index on `jwt_signing_key (createdAt) WHERE rotatedAt IS NULL`, backing `SigningKeyRecords.ts`'s `findCurrent` query (`WHERE rotatedAt IS NULL ORDER BY createdAt DESC LIMIT 1`) — added as a third migration entry (`create_jwt_signing_key_active_index`), not a rewrite of the existing one, since migrations are append-only. Deliberately did **not** extend this to "the other 10 plugin-declared tables" the recommended fix also mentions — that is the exact scope of the separate BE-001/BAM-002/DRS-003 findings (all three explicitly about all-11-tables-have-no-migrations), so doing it here would duplicate work already tracked elsewhere; this finding's own evidence is specifically `Jwt.ts:172`/`jwt_signing_key`.

TDD: extended `packages/jwt/test/RevocationStore.test.ts`'s `Jwt.Jwt.migrations` describe block — bumped the applied-migration-count assertion from 2 to 3, and added a new test that queries sqlite's own `sqlite_master` catalog for the index by name (proves the DDL actually ran, not just that the migration step didn't error). Verified to genuinely fail (both assertions) with the new migration entry reverted; restored, full suite (10/10 in this file) passes. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (650 passed, 7 skipped).
