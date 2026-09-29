---
ID: "SEA-007"
Title: "The one runnable example deliberately avoids any SQL backend, so no end-to-end SQLite composition is demonstrated"
Level: info
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "examples/memory-server/index.ts:5"
Auditor: "sqlite-embedded-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SEA-007 — The one runnable example deliberately avoids any SQL backend, so no end-to-end SQLite composition is demonstrated

`INFO` · `architecture` · `—` · reported by **SQLite Embedded Auth Specialist** (`sqlite-embedded-auth-specialist`)

Status: **ready-for-agent**

## Summary

examples/memory-server composes two plugins over @awthaq/test's memory backend, and the README quickstart targets Postgres — so a developer evaluating awthaq for a single-node embedded deployment cannot run anything that exercises the SQLite path end-to-end (client construction, CoreMigrations migration run, encryption key wiring, real file durability). The pieces are all shipped and tested at the package level, but the composition-root wiring an embedded deployer needs exists only as prose snippets (README:200 notes a local in-memory-SQLite smoke test; the spec appendix shows a two-line wiring). For the persona's stated migration path — start embedded on SQLite, move to Postgres without rewriting plugin code — the repo proves the repository-layer swap but never demonstrates it.

## Evidence

Source: `examples/memory-server/index.ts:5`

```
// memory backend instead of Postgres — no `DATABASE_URL`, no migration
// run, no `AWTHAQ_ENCRYPTION_KEY`. Additional to, not a replacement for,
```

## Recommended fix

Add examples/sqlite-server alongside memory-server: same plugin composition, SqliteClient.layer over a file, Migrator.make with CoreMigrations, AWTHAQ_ENCRYPTION_KEY from env. It doubles as the living proof that SQLite-to-Postgres is a one-layer substitution.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Embedded SQLite Persistence
- Full dossier: [`sqlite-embedded-auth-specialist`](../../.reports/sqlite-embedded-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-008` — Zero subscribers shipped anywhere — a default install records security events nowhere](medium/ALF-008-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`CSD-010` — The only runnable example composes a permissive limiter — out-of-the-box showcase has throttling off](low/CSD-010-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`EOTS-006` — packages/server ships no logging/observability surface; example app uses bare console.log](medium/EOTS-006-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`PCS-005` — Zero tests exercise the cached-decision path or any invalidation trigger in this repo](medium/PCS-005-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `examples/memory-server/index.ts:5`. Fix: Make examples/sql-server (created for SMS-006) default to a SQLite file and switch to Postgres when DATABASE_URL is set — a living proof of README.md:200's one-layer-swap claim. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
