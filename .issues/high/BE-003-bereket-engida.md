---
ID: "BE-003"
Title: "CLI is an empty placeholder — no schema/migration tooling exists"
Level: high
Category: "api"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:8"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-003 — CLI is an empty placeholder — no schema/migration tooling exists

`HIGH` · `api` · `cli` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

The 10-line index names the intended commands (doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import) but nothing is implemented (BEH-EA-201–208 unspecified). In better-auth the CLI is the bridge between plugin schema and the user's database (`@better-auth/cli generate`/`migrate`); without it, BE-001 has no user-facing remedy — a developer cannot even discover which tables a composition needs except by reading plugin source. This is the biggest single adoption blocker relative to the better-auth onboarding loop.

## Evidence

Source: `packages/cli/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Prioritize cli.ts: `migration status|apply` driven by the composed Auth manifest plus the aggregated plugin migrations would close BE-001 and BE-003 together; `routes` and `openapi` fall out of the single HttpApi value almost for free.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CTA-001` — CLI package has zero auth surface and its planned command set contains no login command](high/CTA-001-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-002` — CLI package is an empty placeholder — no login flow exists to consume a future device flow](high/DAG-002-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ELC-008` — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder](info/ELC-008-effect-layer-context-architect.md) `_(effect-layer-context-architect, info)_`
- [`ERS-008` — CLI package is an empty placeholder: no runtime-adjacent tooling exists](info/ERS-008-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, info)_`
- [`FAMS-010` — No bulk user-import tooling; the planned CLI import command is unimplemented](medium/FAMS-010-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`MW-006` — Operational CLI is an empty stub; migrations apply only in-process at app startup](medium/MW-006-matias-woloski.md) `_(matias-woloski, medium)_`
- [`RRM-011` — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder](info/RRM-011-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [CLI schema/migration tooling & better-auth import tooling scope](../../.scratch/resolve-ready-for-human-findings/issues/07-cli-schema-migration-tooling.md) — real `packages/cli` command tree on `effect/unstable/cli`'s `Command`, with `migration status|apply` wrapping the existing `Migrations.run`/`CoreMigrations` Migrator wiring and `doctor`/`routes`/`openapi`/`plugin list --graph` as thin reads of `Auth.make`'s already-static `Built<P>` manifest. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/cli/src/index.ts` is verbatim as quoted: 10 lines, `export {};`, no other files under `packages/cli/src/`. The evidence and claim are exact. However the fix spans 8 unspecified commands (BEH-EA-201-208 "unspecified" per the auditor's own summary) with real CLI UX/scope decisions (e.g. what `doctor` checks, `seed admin` flow shape) — not a single mechanical change, even though `migration status|apply` alone is comparatively well-scoped. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-manifest-tooling`. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Fix: Build the @awthaq/cli command tree per decision 07 (doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import mechanism). (effort XL). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.

**Plan note (2026-09-29, P09):** the migration id-space hazard this issue must respect is fixed in the libraries (N11): core migrations record in `effect_sql_migrations` (`CoreMigrations.coreMigrations`, ids 1-17), plugin migrations in `awthaq_plugin_migrations` (`Migrations.run(auth.migrations)`, `pluginMigrationsTable`), the SQL rate limiter in `awthaq_rate_limiter_migrations`. A CLI `migration apply` must run core first, then `Migrations.run(auth.migrations)` with the default table; never concatenate the two id spaces into one ledger. Plugin ids are positions in the dependency-ordered list, so appending plugins (not inserting mid-order) is safe on a migrated database. See `packages/sql/README.md` "Running migrations" and BEH-EA-038.

**Resolved (2026-09-29):** @awthaq/cli built per decision 07 on effect/unstable/cli (ADR-EA-027): doctor (+ --build), config list, plugin list --graph (text/json/dot), routes, openapi, migration status|apply, seed admin, import, login|logout|whoami; awthaq.config.ts loader (bare composition, Effect, or defineConfig), bin entry, README. Runs against an app's config module without starting an HTTP server (packages/cli/test/*, and the built binary was exercised: routes, plugin list, doctor, migration apply/status on SQLite, exit codes 0/2/3/9). Checked hazards: plugin and core migrations use separate ledgers and go through Migrations.run; the Postgres regclass codec is registered on the CLI's own client; doctor warns on RateLimiter.layerPermissive and a development Mailer (--build), audits BodyLimit, cookie SameSite, etc.; CSRF secret >= 32 bytes and the encryption keyset surface as --build failures. Deferred (spec BEH-EA-202 says so): plugin list --graph prints order, dependsOn, groups and tables but not a plugin's required ports or hook-tap chain, which are not derivable without evaluating layers (hook introspection depends on per-composition hook registries, P10). Closes MW-006, ELC-008, ERS-008, RRM-011 with it.
