---
ID: "JH-006"
Title: "Static layer type matches the runtime fold only when the tuple is pre-sorted"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Auth.ts:207"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-006 — Static layer type matches the runtime fold only when the tuple is pre-sorted

`MEDIUM` · `correctness` · `core` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **ready-for-agent**

## Summary

linkPlugins topologically sorts at runtime (Auth.ts:257-301), so Auth.make accepts plugins in any order — Validate<P> checks duplicates and missing deps regardless of position — but Built<P>["layer"] is FoldLayer<P>, a fold over the tuple as written (Auth.ts:211-231). Pass [Dependent, Dependency] and the program runs correctly while the static RIn of built.layer describes the wrong requirement graph: callers who Layer.provide based on the type (the documented app pattern, examples/memory-server/index.ts:76-79) get misleading errors or, worse, a type that hides a genuinely unsatisfied requirement. Compile-time and runtime disagree about the one thing the linker exists to normalize.

## Evidence

Source: `packages/core/src/Auth.ts:207`

```
 * correct regardless of the order plugins were passed in — when `P` itself
 * already lists dependencies before dependents; `Auth.make`'s own examples,
 * and `test/AuthPlugin.test.ts`, do exactly that.
```

## Recommended fix

Either enforce dependency-before-dependent order in Validate<P> (a type-level MissingDep variant that fires on inversion, matching the runtime's freedom to reorder being dropped) or type layer as the runtime actually behaves — e.g. compute FoldLayer over the topologically sorted tuple at the type level for small tuples, or widen to a sound conservative type with the precise fold left as a documented best-effort.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EHA-001` — Duplicate group-id refusal (BEH-EA-032) unimplemented: colliding groups silently overwrite](high/EHA-001-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`MW-002` — Served API surface is fragmented across three HttpApi values; core session/account routes are unreachable via Auth.make](high/MW-002-matias-woloski.md) `_(matias-woloski, high)_`
- [`MA-007` — Built<P>['layer']'s static type assumes caller-side dependency ordering the runtime does not require](medium/MA-007-michael-arnaldi.md) `_(michael-arnaldi, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `plugin-composition-soundness`. Evidence at HEAD ec065a7: `packages/core/src/Auth.ts:218`. Fix: Make the static fold provably equal to the runtime fold by refusing out-of-order tuples in Validate<P> (dependency must be listed before its dependent). (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
