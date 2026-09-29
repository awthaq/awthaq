---
ID: "MA-007"
Title: "Built<P>['layer']'s static type assumes caller-side dependency ordering the runtime does not require"
Level: medium
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/src/Auth.ts:207"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-007 — Built<P>['layer']'s static type assumes caller-side dependency ordering the runtime does not require

`MEDIUM` · `api` · `core` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **resolved**

## Summary

Auth.make's runtime is order-insensitive: linkPlugins topologically sorts before composeLayer folds. But the static mirror FoldLayer walks P in the caller's literal order, so for a tuple passed as [Dependent, Dependency] the runtime fold (topological, correct) and the type-level fold (caller order, different ProvideMerged sequence) diverge: the resulting layer's static RIn/ROut claims requirements that the value it types does not actually have (and vice versa). Nothing rejects the out-of-order tuple — Validate<P> checks duplicates and missing deps, not order — so the divergence is reachable by any caller who relies on the runtime's documented order-insensitivity. It is a soundness gap in an otherwise exemplary type-level design, and the comment itself concedes the invariant is caller discipline, not an enforced fact.

## Evidence

Source: `packages/core/src/Auth.ts:207`

```
 * correct regardless of the order plugins were passed in — when `P` itself
 * already lists dependencies before dependents; `Auth.make`'s own examples,
 * and `test/AuthPlugin.test.ts`, do exactly that.
```

## Recommended fix

Either enforce canonical order at the type level (a SameOrderCheck<P> in Validate<P> that demands each plugin's dependsOn ids appear earlier in the tuple — the mechanism already exists for MissingDep) or invert the design: make linkPlugins' order the source of truth and derive FoldLayer from a type-level topological walk, so the static and runtime folds cannot disagree.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EHA-001` — Duplicate group-id refusal (BEH-EA-032) unimplemented: colliding groups silently overwrite](high/EHA-001-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`JH-006` — Static layer type matches the runtime fold only when the tuple is pre-sorted](medium/JH-006-jared-hanson.md) `_(jared-hanson, medium)_`
- [`MW-002` — Served API surface is fragmented across three HttpApi values; core session/account routes are unreachable via Auth.make](high/MW-002-matias-woloski.md) `_(matias-woloski, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `plugin-composition-soundness`. Duplicate of `JH-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Auth.ts:225`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
