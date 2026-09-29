---
ID: "TTE-006"
Title: "Double `any` in GroupsFor erases endpoint checking at the plugin contract boundary"
Level: medium
Category: "api"
Status: needs-triage
Package: "core"
Source: "packages/core/src/AuthPlugin.ts:34"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-006 — Double `any` in GroupsFor erases endpoint checking at the plugin contract boundary

`MEDIUM` · `api` · `core` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **needs-triage**

## Summary

Every plugin's `Groups extends GroupsFor<Id>` constraint widens endpoint and error types to `any`, so a plugin author can hand `Auth.make` a contract whose endpoints never type-check against anything. The comment (lines 24-31) honestly documents why: `HttpApiGroup`'s `Endpoints` parameter is invariant (`in out`), so no widened bound admits concrete groups — this is an upstream-forced tradeoff, handled as well as it can be locally (scoped lint-disable, written rationale, and composition reads only `ContractData` data, never methods). Still, it is the one place a plugin author gets no compile-time protection.

## Evidence

Source: `packages/core/src/AuthPlugin.ts:34`

```
export type GroupsFor<Id extends string> = HttpApiGroup.HttpApiGroup<
  Id | `${Id}.${string}`,
  any,
```

## Recommended fix

Keep the workaround but shrink its blast radius: alias the `any` once (`type InvariantHole = any`) with the existing comment, and add a plugin-level contract test kit (the `@awthaq/test` `runPluginContractTests` harness already exists) that type-checks each shipped plugin's contract against its own handlers, recovering at CI the checking the constraint cannot express.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ELC-006` — AuthPlugin.layer silently overwrites a prior dependsOn registration for the same plugin class](low/ELC-006-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`MA-003` — 114 import sites of effect/unstable/* embed rc-era module paths into the library's public types](high/MA-003-michael-arnaldi.md) `_(michael-arnaldi, high)_`
- [`SAM-004` — No home for auth.users metadata; plugin-contributed fields are spec-only](medium/SAM-004-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `plugin-composition-soundness`. Evidence at HEAD ec065a7: `packages/core/src/AuthPlugin.ts:31`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/01-core-sessions-users.md`.
