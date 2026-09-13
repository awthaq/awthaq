# ADR-EA-001: Plugins Contribute Effect Layers

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-001 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

## Context

awthaq is built as a stack of seven strata (PRD §8: Contract, Ports, Persistence, Domain, HTTP, Authorization, Composition), each of which "depends only on strata below it" and exposes its capabilities as `layer` / `layerNoDeps` / `layerMemory`. Above this stratified core sits a plugin system (PRD §9) through which optional sign-in methods, session extensions and authorization bindings are added to an application. The foundational question a plugin system must answer is: what *is* a plugin, mechanically? Competing auth frameworks answer this with an ad hoc object shape assembled and interpreted by a bespoke runtime — better-auth's `BetterAuthPlugin` is the paradigm case, a plain record of optional fields (`init`, `endpoints`, `middlewares`, `hooks`, `schema`, `migrations`, …) that a hand-written compiler walks at boot to stitch routes, hooks and schema together (better-auth/03-plugin-system/01-plugin-contract.md §0; research/02-better-auth.md Q20). That approach requires the framework to build and maintain its own dependency resolution, its own lifecycle management, its own resource acquisition/release, and its own conflict detection — none of which are auth-specific problems, and all of which Effect already solves generically for any composed program via `Layer`.

Effect's `Layer<ROut, E, RIn>` already models exactly what a plugin needs to express: what it provides (`ROut`), what it can fail with (`E`), and what it requires from its environment (`RIn`), with memoized construction, scoped acquisition/release, and typed composition via `Layer.provide` / `Layer.mergeAll` (research/01-effect-ecosystem.md Q10, Q11). A plugin system that reinvents these primitives duplicates infrastructure Effect ships for free and gets it — as `research/01-effect-ecosystem.md` shows for even Effect's own ecosystem — subtly wrong in ways the type checker would otherwise catch (memoization edge cases, unscoped resources, silent merge-order conflicts).

## Decision

A plugin **contributes an Effect `Layer`**. There is no separate plugin runtime, no custom lifecycle hook set, and no bespoke resource manager: everything a plugin does — providing its own service, registering HTTP handlers, tapping hook points, overriding slots — is expressed as ordinary `Layer` algebra (`Layer.effect`, `Layer.provideMerge`, `Layer.mergeAll`), composed by `Auth.make` the same way any Effect application composes layers. Plugin authorship is Awthaqorship; there is nothing else to learn.

This decision is the foundation the other eleven ADRs in this set build on: ADR-EA-002 (the plugin graph is read off the Layer's type-level `RIn`/`ROut`), ADR-EA-008 (a plugin is a `Context.Service` class whose static is a `Layer`), ADR-EA-010 (ports are things plugins require in `RIn`, never provide), and ADR-EA-011/012 (config and slots are themselves `Layer`/`Context.Reference` values) are all direct consequences of treating the Layer as the one unit of plugin contribution.

## Alternatives considered

**A bespoke declarative contribution record, interpreted by a custom compiler** — the model better-auth uses (a frozen `{ id, init, endpoints, middlewares, hooks, schema, migrations, ... }` object walked by hand-written composition code; better-auth/03-plugin-system/01-plugin-contract.md) and the model an earlier iteration of this project's own design sketched (`archive/design/api-design.md` v0.1's `definePlugin`, a frozen record with static and runtime halves modeled on VS Code's `contributes` blocks). This buys one thing the pure-Layer model does not give for free: contribution metadata that can be inspected *without executing any code*, which is attractive for tooling (`auth plugin list --graph`, docs generation) (research/09-plugin-architecture.md TL;DR). It was rejected as the *primary* contract because it requires the framework to re-implement, by hand, the composition machinery — ordering, memoization, resource lifetimes, conflict detection — that `Layer` already provides, and because the type checker cannot see through an opaque record the way it can see through a `Layer`'s type parameters (research/01-effect-ecosystem.md Q10's hybrid recommendation explicitly warns that "wrapping service construction in custom descriptors would buy nothing for validation ... and would break `Layer.memoize`/scoped-release semantics").

## Consequences

**Positive**: Plugin composition inherits everything Effect already built for layers — memoized construction, scoped acquire/release, typed requirements, and a decade of ecosystem tooling (testing via layer substitution, `ManagedRuntime`, ecosystem familiarity for any Effect developer). There is no second runtime to document, version, or keep in sync with Effect's own semantics.

**Negative**: Contribution metadata that is not encoded in the Layer's type (human-readable plugin names for error messages, documentation strings, CLI-facing manifests) has to be attached separately, as static properties on the plugin's `Context.Service` class (ADR-EA-008), rather than falling out of a single declarative record the way it would in the rejected alternative.

**Trade-off accepted**: The project gives up a single point where *all* plugin metadata (static and runtime) lives in one interpretable value, in exchange for correctness and composition guarantees the type checker enforces automatically. Anything the CLI needs to introspect (ADR-EA-002's `manifest`) must be derived from the Layer's type-level channels and a small amount of accompanying static data, rather than read off one uniform record.

Not yet implemented — see spec/roadmap.md for milestone.
