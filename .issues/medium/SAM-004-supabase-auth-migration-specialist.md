---
ID: "SAM-004"
Title: "No home for auth.users metadata; plugin-contributed fields are spec-only"
Level: medium
Category: "api"
Status: ready-for-human
Package: "core"
Source: "packages/core/src/AuthPlugin.ts:126"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-004 — No home for auth.users metadata; plugin-contributed fields are spec-only

`MEDIUM` · `api` · `core` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **ready-for-human**

## Summary

Supabase apps persist profiles and authorization hints (plan tier, staff flags) in raw_user_meta_data/raw_app_meta_data and read them back inside RLS policies via auth.jwt(). effect-auth's User/Account are closed Model.Class entities with six and nine fields respectively (packages/sql/src/Models.ts:40-98), and the declared extension mechanisms — BEH-EA-040's shared-table extension point and BEH-EA-048's plugin-contributed fields (spec/behaviors/06-domain-users-accounts.md:113-125) — have no implementation: AuthPlugin.Service options carry only own-prefixed tables and migrations. Migrated metadata needs a hand-rolled side table joined by userId, with none of the write-gating semantics BEH-EA-048 specifies.

## Evidence

Source: `packages/core/src/AuthPlugin.ts:126`

```
readonly tables?: ReadonlyArray<`${Id}_${string}`>;
readonly migrations?: Migrations;
```

## Recommended fix

Either implement the BEH-EA-040/048 extension point or document the sanctioned pattern (a plugin's own prefixed table keyed by userId) with the client-writability warning BEH-EA-048 already articulates, so app_metadata-style elevation flags do not silently become client-writable.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ELC-006` — AuthPlugin.layer silently overwrites a prior dependsOn registration for the same plugin class](low/ELC-006-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`MA-003` — 114 import sites of effect/unstable/* embed rc-era module paths into the library's public types](high/MA-003-michael-arnaldi.md) `_(michael-arnaldi, high)_`
- [`TTE-006` — Double `any` in GroupsFor erases endpoint checking at the plugin contract boundary](medium/TTE-006-typescript-type-level-engineer.md) `_(typescript-type-level-engineer, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `users-profile-surface`. Evidence at HEAD ec065a7: `packages/core/src/AuthPlugin.ts:126`. Fix: Implement the BEH-EA-040/048 user-field extension point (decision option A), decomposed into four tickets, with interim docs. (effort XL). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-human.
