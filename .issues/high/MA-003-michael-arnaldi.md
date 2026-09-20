---
ID: "MA-003"
Title: "114 import sites of effect/unstable/* embed rc-era module paths into the library's public types"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthPlugin.ts:14"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-003 — 114 import sites of effect/unstable/* embed rc-era module paths into the library's public types

`HIGH` · `architecture` · `core` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **resolved**

## Summary

Measured: 114 `effect/unstable/*` import sites across 51 source files (httpapi 56, sql 33, http 19, reactivity 8, schema 3). The critical exposure is not imports per se but type identity: AuthPlugin.Any's `contract` field, Built<P>['api'], and therefore every third-party plugin author's `AuthPlugin.Service(...)` signature are typed against `effect/unstable/httpapi` classes (see also Auth.ts:22). `unstable/` is Effect's own declared churn zone; when 4.0.0 stable reorganizes these paths (as v3→v4 already did to platform), every downstream plugin breaks at the type level, not just awthaq's build. The exact rc pin (pnpm-workspace.yaml:17) delays but does not remove this cliff, and the repo's own pin rationale concedes rc builds are not ABI-compatible with each other.

## Evidence

Source: `packages/core/src/AuthPlugin.ts:14`

```
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
```

## Recommended fix

Track upstream unstable→stable moves as a first-class migration task pinned to the Effect release notes before 4.0.0 stable; where possible, confine unstable types to invariant type parameters behind awthaq-owned aliases so downstream plugins import one awthaq type, not Effect's unstable path, and add a knip/depcheck rule that fails CI on new effect/unstable imports in public export signatures.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ELC-006` — AuthPlugin.layer silently overwrites a prior dependsOn registration for the same plugin class](low/ELC-006-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`SAM-004` — No home for auth.users metadata; plugin-contributed fields are spec-only](medium/SAM-004-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`
- [`TTE-006` — Double `any` in GroupsFor erases endpoint checking at the plugin contract boundary](medium/TTE-006-typescript-type-level-engineer.md) `_(typescript-type-level-engineer, medium)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Public API surface hardening](../../.scratch/resolve-ready-for-human-findings/issues/25-public-api-surface-hardening.md) — `packages/core`'s barrel re-exports (not wraps) the specific `effect/unstable/httpapi` classes (`HttpApi`/`HttpApiGroup`/`HttpApiEndpoint`/etc.) a third-party plugin author needs, preserving `ADR-EA-003`'s "one contract, no duplication" while insulating downstream plugin-author import paths from Effect's own path reorganization at 4.0 stable; the remaining sql/http/reactivity/schema imports stay internal, invisible once `AVS-001`'s barrel-only export lands, with a new CI lint rule guarding against future leakage. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `AuthPlugin.ts:14-15` matches the evidence verbatim; independently counted `grep -rn "^import.*effect/unstable" packages/**/src` gives 114 import lines across 50 source files (auditor's 51 is a near-exact match), and `AuthPlugin.Any`'s `contract`/`GroupsFor` types are indeed built directly on `effect/unstable/httpapi` classes. The underlying risk (Effect's own declared churn zone leaking into public plugin-author types) is real and verified, but the fix (tracking upstream moves, introducing awthaq-owned type aliases, CI enforcement) is a cross-cutting architecture/API-surface decision, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-20):** Implemented [Public API surface hardening](../../.scratch/resolve-ready-for-human-findings/issues/25-public-api-surface-hardening.md)'s MA-003 half exactly as decided — **re-export, not wrap**, per `ADR-EA-003`'s "one contract, no duplication": new `packages/core/src/HttpApiTypes.ts` re-exports the 6 `effect/unstable/httpapi/*` modules a plugin author's own contract construction actually names (`HttpApi`, `HttpApiEndpoint`, `HttpApiGroup`, `HttpApiMiddleware`, `HttpApiSchema`, `HttpApiSecurity` — the `httpapi` category, 56 of the finding's 114 measured sites, the only category that reaches a plugin author's own public types), barrel'd flat into `@awthaq/core`'s existing `index.ts` (`export * from "./HttpApiTypes.ts"`) so a third-party plugin writes `import { HttpApiGroup } from "@awthaq/core"` instead of naming Effect's own churn-zone path directly. A type alias to a re-exported value creates no second type — same nominal identity, zero divergence risk — only the import path changes, which is exactly what insulates a plugin author from Effect 4.0 stable's own path reorganization (the v3→v4 `platform` move is the cited precedent).

The other 58 sites (sql 33, http 19, reactivity 8, schema 3) get no re-export, deliberately: they are `@awthaq/sql`'s/`@awthaq/server`'s/etc. own internal implementation detail, never part of any package's `index.ts` barrel, so `AVS-001`'s wildcard-export removal (same decision ticket, resolved immediately prior to this finding) already makes them invisible to any consumer importing through a package's own `"."` entry — no separate re-export was needed for them to stop leaking.

TDD: `packages/core/test/HttpApiTypes.test.ts` asserts referential (`toBe`) identity between `@awthaq/core`'s re-exported values and Effect's own direct import, for one representative value per module (`HttpApi.make`, `HttpApiEndpoint.get`, `HttpApiGroup.make`, `HttpApiMiddleware.Service`, `HttpApiSchema.NoContent`, `HttpApiSecurity.apiKey`), plus a `HttpApi.isHttpApi` check proving a value built through the re-exported path is accepted by Effect's own runtime predicate — the concrete, checkable form of "same nominal identity, not a wrapper." Mutation-verified: temporarily replacing `HttpApiTypes.ts`'s `HttpApi` re-export with a spread-plus-fresh-`make`-wrapper object broke the `toBe` assertion for exactly the expected reason (a new function reference), confirmed, then reverted. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (721 passed, up from 720).

**Out of scope, deliberately**: the decision ticket's own CI-enforcement recommendation ("add a lint rule restricting `effect/unstable/*` imports to an explicit allowlist... an implementation detail for the later pass") was investigated and not implemented here. `tools/oxc/` (this repo's custom oxlint JS-plugin rules) is an explicit verbatim copy from `../effect`'s own tooling, "update by re-copying... not by hand-editing rule logic here" per its own header — not a safe place to bolt on a new project-specific rule. A naive grep-based script checking every barrel-exported file for any `effect/unstable` import (attempted, then discarded) flags 51 files, not 6 — it cannot distinguish "imported for internal implementation" from "leaks into an exported signature" without real type-level analysis, so it would either do nothing useful or fail CI immediately on legitimate existing code. Building an accurate version is its own non-trivial effort, correctly left as the decision ticket's own named follow-up rather than shipped half-working here.
