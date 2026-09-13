# ADR-EA-012: Slots Are Exclusive, Registries Aggregate

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-012 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Grounded "Alternatives considered" in NestJS's documented global-provider merge behavior instead of a self-referential PRD citation (CCR-EA-002) |

---

## Context

PRD §9.3 identifies two distinct patterns by which plugins contribute to a shared extension point, and they behave differently on purpose: "**Slots**: exclusive `Context.Reference` overrides, conflict-checked," and "**Registries**: aggregating contributions ordered by dependency, then `order`, then id." Some extension points genuinely have only one correct answer at a time — `SubjectResolver` (PRD §15: the mechanism qadi's subject comes from) can only be resolved one way for a given request; if the `Roles` plugin and the `Organization` plugin both tried to override it independently, whichever composed last would silently win, and the application would have no indication that a conflict occurred (`archive/design/plugins-as-layers.md` §3.5: "If `Organization` also overrides `SubjectResolver`, `Auth.make([Roles, Organization])` fails with the two names. The fix is a plugin that composes both, or one that depends on the other and wraps its resolver"). Other extension points are naturally many-to-one: hook taps, event subscribers, rate-limit rules, session claims, and OpenAPI tags are all things multiple plugins legitimately want to contribute to *simultaneously*, without any notion of one contribution overriding another (`archive/design/plugins-as-layers.md` §3.6: "Where several plugins contribute to one thing, the thing is a registry service and contributions are `Layer.effectDiscard` writes ... Ordering is dependency order, then declared `order`, then plugin id"). Treating both patterns with one mechanism would either wrongly allow silent override where exclusivity is required, or wrongly forbid legitimate multi-plugin contribution where aggregation is required.

## Decision

Two distinct extension mechanisms exist, chosen by whether an extension point's contributions **can conflict**. A **slot** is a `Context.Reference` with a fail-closed default that a plugin may override by providing it in its Layer's `ROut`; `Auth.make` refuses composition — naming both contributing plugins — if more than one plugin in the tuple overrides the same slot (`archive/design/plugins-as-layers.md` §3.5; core slots include `SubjectResolver` and `SessionViewExtension`). A **registry** is a service holding an aggregating cell that any number of plugins may write to via `Layer.effectDiscard`; contributions are ordered by dependency order, then a declared `order` field, then plugin id, and the registry freezes at first read (`archive/design/plugins-as-layers.md` §3.6). Hook points (PRD §9.3, §13's `BeforeSignUp`, `AfterSignIn`, etc.) follow the registry pattern's ordering rules but carry their own kind semantics — veto points run taps in dependency order and may abort or amend, observe points isolate tap failures so one failing observer can never fail the underlying operation (`archive/design/plugins-as-layers.md` §3.4; PRD §13). Which mechanism a given extension point uses is a property of what that extension point *means*, decided once when the point is defined, not a choice left to whichever plugin happens to use it.

## Alternatives considered

**One uniform "last write wins" merge rule for all shared extension points, with no distinction between exclusive and aggregating contributions**, avoiding the need to classify each extension point at all — a real, specific precedent for this exists, not merely a rejected hypothetical: `research/09-plugin-architecture.md` documents NestJS's dependency-injection container as behaving exactly this way for providers bound at the global scope — "NestJS global modules can similarly collide without ceremony" alongside its account of Angular's `multi: true` providers, which "aggregate append-only — safe for collections — but a plain duplicate provider *silently overrides* (last-wins)." NestJS supplies no equivalent of a slot/registry distinction: a global provider is simply overwritten by whichever module registers it last, with no compiler or container error naming the collision, for both exclusive services (a single canonical implementation, the shape `SubjectResolver` needs) and aggregating ones (multiple independent contributors, the shape hook taps and event subscribers need) alike. This was rejected because it is precisely the "incidental merge order" hazard `research/01-effect-ecosystem.md` Q11 separately warns about for capability overrides generally, made concrete by NestJS's own documented behavior: a silent override of `SubjectResolver` — a security-relevant piece of state that determines what a principal is authorized to do downstream via qadi (ADR-EA-009) — with no compile-time signal that two plugins are competing for it would be a serious authorization hazard, not merely the DX inconvenience it is for an ordinary NestJS provider collision. Conversely, forcing every extension point (including inherently many-to-one ones like hook taps and event subscribers) through an exclusivity check would make legitimate, desired multi-plugin composition (e.g., two independent plugins both wanting to observe `AfterSignIn`) impossible without artificial workarounds — the opposite failure NestJS's uniform model exhibits, but a failure nonetheless.

## Consequences

**Positive**: The type of a contribution states its own conflict semantics — a slot override that collides with another plugin's is caught by name at `Auth.make`, exactly like a missing dependency (ADR-EA-002); a registry contribution never needs a conflict check because aggregation is its intended behavior. Authors and reviewers can tell, from an extension point's declared kind alone, whether two plugins touching it is a composition error or ordinary, expected composition.

**Negative**: Plugin authors and, more importantly, authors of *new* extension points (core maintainers extending the plugin surface) must correctly classify each new point as a slot or a registry up front; misclassifying an inherently exclusive concern as a registry would silently reintroduce the override-conflict hazard this ADR exists to prevent, since registries by design accept unlimited contributions without conflict checking.

**Trade-off accepted**: The project accepts the ongoing design discipline of classifying every extension point correctly (rather than defaulting to one universal merge rule) in exchange for exclusivity guarantees where they matter (subject resolution, session-view extension) and unrestricted aggregation where multiple contributions are the intended, desired behavior (hooks, events, rate limits, session claims).

Not yet implemented — see spec/roadmap.md for milestone.
