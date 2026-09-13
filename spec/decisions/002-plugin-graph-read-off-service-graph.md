# ADR-EA-002: The Plugin Graph Is Read Off the Service Graph

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-002 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | effect-auth Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

## Context

An earlier design iteration (`archive/design/api-design-v4.md` §8, referenced in `archive/design/plugins-as-layers.md`'s opening line as "the plugin model of `design/api-design-v4.md` §8") modeled plugin composition as **two separate graphs**: a *service graph* (the ordinary Effect `Layer` dependency graph that determines what gets constructed and in what order) and a *plugin graph* (a parallel structure of plugin ids, `requiresPlugins` lists, capability claims, and route/table ownership that a hand-written linker walked at boot to answer questions like "does plugin B's dependency on plugin A exist," "do two plugins claim the same slot," and "in what order do migrations run"). This mirrored the reasoning in `research/01-effect-ecosystem.md` Q10, which recommended a *hybrid* of "declarative contributions for everything the compiler must introspect ... plus raw Layers for services" on the grounds that plain Layers cannot answer plugin-identity questions ("Layer.Services extract a layer's ... channels" was not yet known to be sufficient).

That reasoning was revised once the project's Effect v4 target (ADR-EA-007) put `Context.Service` class instances, and the accompanying type-level extractors `Layer.Success`, `Layer.Error`, and `Layer.Services`, in scope (`archive/design/plugins-as-layers.md` §0, checked directly against the v4 rc source: "`Context.Service` class instances carry a literal `key`, `Layer.Success`/`Layer.Error`/`Layer.Services` extract a layer's three channels"). A plugin's identity (its literal service key), its requirements (`RIn`, i.e. `Layer.Services`), and its contributions (`ROut`, i.e. `Layer.Success`) are now all already present in the type of the Layer a plugin was going to contribute anyway under ADR-EA-001. Maintaining a second, parallel metadata graph to answer questions the Layer's own type already answers is redundant machinery that itself needs validating, versioning, and keeping in sync with the "real" service graph — precisely the class of bug the type checker should be eliminating, not reproducing.

## Decision

There is **one graph**: the ordinary Effect service/Layer dependency graph. The "plugin graph" — which plugin depends on which, which slot is claimed by whom, which requirement is still unmet — is **read off** that graph's type-level channels (`RIn`/`ROut`/`Success`/`Error` per `archive/design/plugins-as-layers.md` §0) rather than maintained as separate runtime or compile-time metadata. `Auth.make`'s `Validate<P>` (`archive/design/plugins-as-layers.md` §4.2) walks the tuple of plugin classes pairwise, reading `id`, `ROut`, and `RIn` directly off each plugin's `Context.Service` class and its Layer — it does not consult or maintain a separate plugin-graph data structure.

Two concerns remain, deliberately, at runtime rather than in the type system: **cycle detection** in `dependsOn` (unrepresentable at the type level across ES modules, since a cycle would require two classes to import each other; the linker still checks it operationally) and **migration ordering** (derived from `dependsOn` — core first, then topological order, then plugin id — and executed by the SQL driver's `Migrator`). Everything else that the old two-graph design assigned to a runtime linker — missing dependencies, duplicate ids, slot conflicts, contract/handler mismatches, `apiVersion` mismatches, hook points tapped but never defined — is answered by `Layer.launch` refusing to compile, or by `Auth.make`'s pairwise `Validate<P>` naming the specific plugin (`archive/design/plugins-as-layers.md` §1's table enumerates the full mapping of situation to failure point).

## Alternatives considered

**Two separate graphs — a service/Layer graph plus a hand-maintained plugin graph of ids, `requiresPlugins`, and capability metadata** — this project's own earlier design (`archive/design/api-design-v4.md` §8), consistent with `research/01-effect-ecosystem.md` Q10's hybrid recommendation made before v4's `Context.Service`/extractor mechanics were confirmed available. It was rejected once it became clear the metadata the second graph existed to carry (plugin identity, dependency requirements, contribution surface) is already present, faithfully and automatically, in the Layer's own type — maintaining a duplicate structure would only create a second source of truth that could drift from the first, and would require its own validation logic that the type checker could not help with.

## Consequences

**Positive**: There is exactly one thing to keep consistent, and the type checker keeps it consistent for free. `Auth.make`'s error messages ("plugin `two-factor` depends on plugin `password`, which is not in the list," `archive/design/plugins-as-layers.md` §4.3) can *name* a missing plugin precisely because the plugin-requirement service the type carries encodes `key: "effect-auth/plugin/<id>"` — the same mechanism that would otherwise require a hand-maintained id table now produces better diagnostics than the two-graph design did.

**Negative**: Anything that is not naturally expressible as a Layer's type-level channel (in practice: cycle detection and migration ordering, per the Context above) still needs a small amount of runtime logic outside the pure type-level story. The plugin system is not *entirely* free of runtime bookkeeping, only free of a second parallel *graph*.

**Trade-off accepted**: The project gives up having an independently inspectable, purely-data plugin manifest that exists prior to and separate from Layer construction (which would have been trivially serializable for tooling) in exchange for a single source of truth with no drift risk; the CLI-facing `manifest` (`archive/design/plugins-as-layers.md` §4.1) must instead be *derived* from the Layer graph's types plus the small amount of static class data each plugin carries (ADR-EA-008), rather than authored directly.

Not yet implemented — see spec/roadmap.md for milestone.
