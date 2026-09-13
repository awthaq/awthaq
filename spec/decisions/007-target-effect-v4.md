# ADR-EA-007: Target Effect v4

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-007 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | effect-auth Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

## Context

As of the research pass behind this decision (`research/01-effect-ecosystem.md`, verified against npm/unpkg/effect.website on 2026-09-12), stable Effect is `3.22.2`, and Effect v4 is a release candidate — `4.0.0-rc.115`, RC announced 2026-08-12, "no more broad breaking changes planned," stable targeted Q3/Q4 2026, installed via `effect@rc` and requiring TypeScript ≥ 5.9. The plugin architecture this project depends on — `Context.Service` classes with literal keys, the `Layer.Success`/`Layer.Error`/`Layer.Services` extractors that let `Auth.make` read a plugin's identity, requirements, and contributions directly off its Layer's type (ADR-EA-002), `HttpApiGroup.ToService`/`HttpApiBuilder.layer`'s per-group service requirement (ADR-EA-003), `Model.Class`/`SqlModel` repositories (ADR-EA-004), `LayerMap`/`LayerRef` for per-tenant configuration (ADR-EA-006, ADR-EA-011), and `AtomHttpApi` for reactive clients (PRD §16) — is explicitly checked in `archive/design/plugins-as-layers.md` §0 against "`../effect` (v4 rc)," not against stable v3. Several of these are v4-line features that do not exist, or do not exist in the needed form, in Effect 3.22: `research/01-effect-ecosystem.md` states plainly that "the PRD's `Context.Service` API does not exist in Effect 3.22," that `HttpApi` streaming lands "in the v4 beta, June 2026" (not v3), and that v4 "consolidates the ecosystem" so that `@effect/platform`/`rpc`/`cluster` move into `effect` itself under `effect/unstable/*`, with a rewritten fiber runtime and a roughly 70 kB → 20 kB reduction in minimal bundle size.

`research/01-effect-ecosystem.md`'s own top-line recommendation, made from a risk-conservative research posture, was to "target `effect@^3.22` for v1; run a nightly CI job against `effect@rc` (v4) from day one." This project's decision departs from that recommendation: the substrate that makes the plugin design small — multi-scheme middleware, `addHttpApi`, `Model`, `AtomHttpApi`, `LayerMap`, `LayerRef` (PRD §22, ADR-007's row) — is v4-only, and building against v3 first would mean designing the entire plugin system twice: once against v3's `Effect.Service`/`Context.Tag` idioms, and again when v4 stabilizes and the design this project actually wants becomes available.

## Decision

effect-auth targets **Effect v4** as its foundation, starting from the rc line, not stable v3. This is stated without hedging: the rc/pre-stable status of v4 is a known, accepted fact, and the decision to build on it anyway is **the project owner's own risk to carry**, not a decision the project is uncertain about or planning to revisit if v4 takes longer to stabilize than announced. The PRD states this directly: "Stability of the rc line is the project's own risk to carry; the substrate ... is what makes the design small" (PRD §22, ADR-007). This is a deliberate trade-off, made with full knowledge of the alternative (build on stable v3, migrate later), and rejected because building the plugin architecture on v3 first would mean building it twice.

## Alternatives considered

**Target stable Effect v3 (`^3.22`) for v1, tracking v4 via nightly CI only** — the posture `research/01-effect-ecosystem.md` itself recommends from a conservative-risk standpoint, and the more common choice for a production library that cannot ask its users to depend on a pre-1.0 release candidate. This was considered and rejected for effect-auth specifically because the plugin model's core mechanism — reading plugin identity and requirements off `Context.Service`/Layer type extractors (ADR-EA-002) — depends on v4-line context system changes ("the context system was rebuilt as `ServiceMap` then renamed back to `Context`," research/01-effect-ecosystem.md), and because `HttpApi`'s v3 form lacks streaming and carries "a known middleware-skipping bug class (#6121)" that the v4 beta/rc line addresses. Building against v3 would produce a materially different, more complex plugin system now, which would then need to be redesigned around v4's simplifications once it stabilizes — the "build it twice" cost the project chose to avoid.

## Consequences

**Positive**: The plugin design is as small as PRD §22 claims specifically because it leans on v4-only primitives; effect-auth avoids building interim workarounds for a context/service model that is about to be superseded, and gets a smaller runtime footprint (~20 kB minimal bundle vs. ~70 kB) and a rewritten, faster fiber runtime for free by virtue of building on v4 from the start.

**Negative**: effect-auth ships depending on a release candidate with "no more broad breaking changes planned" but not yet a stable release; users of effect-auth inherit that same risk one level removed — an effect-auth v1 release built on `effect@rc` cannot itself claim the stability guarantees a library built on a stable dependency would carry, and any late-breaking change in the v4 rc→stable transition becomes effect-auth's problem to absorb.

**Trade-off accepted**: The project knowingly accepts pre-1.0 dependency risk on its single most foundational dependency, in exchange for a plugin architecture that is simpler and more correct than anything achievable on stable v3 today. This is not a hedge or a placeholder decision — it is the deliberate, accepted cost of building the design the project actually wants rather than an interim design that would need to be discarded when v4 ships.

Not yet implemented — see spec/roadmap.md for milestone.
