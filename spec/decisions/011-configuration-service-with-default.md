# ADR-EA-011: Configuration Is a Service With a Default

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-011 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Sharpened the Negative consequence to name the `@experimental` Context.Reference risk explicitly, contrasted with ADR-EA-007 (CCR-EA-002) |

---

## Context

ADR-EA-006 establishes that installation and configuration are separate axes; this ADR fixes the concrete mechanism configuration uses. A plugin such as `Password` has options — minimum password length, breach-checking policy, reset-token TTL, whether to rehash on login — that must be safely overridable per application, per tenant, or per test, without becoming constructor arguments that fix a plugin's behavior for the lifetime of the composed Layer. `archive/design/plugins-as-layers.md` §3.1 states the reasoning directly: "Options are not constructor arguments. They are a `Context.Reference` the plugin reads; the application overrides it with a Layer. That makes options overridable per tenant, per test, or per environment with the same mechanism as everything else." `Context.Reference` is a v4-line context primitive (ADR-EA-007) that creates a tag carrying a **default value**, so that an application which never overrides `PasswordConfig` still gets a working plugin, while one that does override it gets a type-checked replacement — "a missing override is never an error: the default applies. A *wrong* override is a type error against the reference's shape" (`archive/design/plugins-as-layers.md` §3.1).

## Decision

Every plugin option surface is a `Context.Reference<Shape>` declared with a `defaultValue`, e.g. `PasswordConfig = Context.Reference<{ minLength: number; breachCheck: ...; resetTtl: Duration.Duration; rehashOnLogin: boolean }>("awthaq/password/Config", { defaultValue: () => ({ minLength: 12, breachCheck: false, resetTtl: Duration.hours(1), rehashOnLogin: true }) })`. Each plugin exposes a `.config(partial)` sugar function returning `Layer.succeed(PasswordConfig, { ...PasswordConfig.defaultValue(), ...partial })`, so an application overrides options the same way it overrides anything else — `Layer.provide(Password.config({ minLength: 16, breachCheck: { onUnavailable: "reject" } }))` (`archive/design/plugins-as-layers.md` §3.1). Per-tenant variation composes the same reference through `LayerMap.Service` (the `TenantAuthConfig` example, same section) without any change to the plugin's contract. Inside a plugin's `make` effect, configuration is read exactly like any other dependency: `const config = yield* PasswordConfig` (PRD §9.1).

## Alternatives considered

**Plain constructor-argument options, passed at plugin-installation time** — the shape used by better-auth (`password({ minLength: 12 })` fixes the option for the life of the `betterAuth` instance) and by this project's own earlier `definePlugin` sketch, where a plugin factory's options and its installation happen in one call. This was rejected for the same reason ADR-EA-006 gives generally: constructor-argument options cannot be overridden per tenant or per test without re-running the entire plugin composition, and they have no principled "default if absent, type-checked if present" behavior — an absent option under the constructor-argument model is handled by ad hoc default-merging logic inside the plugin factory, rather than by a single, uniform mechanism (`Context.Reference`'s `defaultValue`) shared by every plugin and by core services alike.

## Consequences

**Positive**: One mechanism (`Context.Reference` + `.config` sugar + `Layer.provide`) handles configuration for every plugin and for core services alike; a missing override is never a runtime error, only ever the documented default; a malformed override is caught by the type checker against the reference's declared shape rather than by runtime validation; the identical mechanism scales to per-tenant configuration via `LayerMap` with no change to the plugin's contract.

**Negative**: `Context.Reference` is not a settled, stable primitive that ADR-EA-011 merely happens to use — it is marked `@experimental` as of the v3 line (`research/01-effect-ecosystem.md` Q11), and awthaq's entire configuration mechanism, for every plugin, official and third-party alike, is built directly on it. This is a materially sharper risk than "one more concept to learn": if `Context.Reference`'s shape or default-resolution semantics change before v4 stabilizes, every plugin's `.config` sugar function and every `defaultValue` declaration is affected simultaneously, because there is no plugin that configures itself any other way (ADR-EA-006 rules out constructor-argument options as the fallback). This is unlike ADR-EA-007's stance on Effect v4 as a whole, where the project explicitly and knowingly accepts rc-line risk as "the project owner's own risk to carry" for the *entire* dependency, stated without hedging precisely because ADR-EA-007 treats that risk as a single, named, top-level decision the project owns. ADR-EA-011 does not carry the same explicit acknowledgment for the specific primitive it leans on hardest for the configuration surface — `Context.Reference` is used here as though its `@experimental` marking were already resolved, without ADR-EA-007's discipline of stating that risk as a decision in its own right for this one API.

**Trade-off accepted**: The project accepts that `Context.Reference`'s pre-stable status is effectively re-incurred, unacknowledged, at the level of every single plugin's configuration surface — not just once, at the foundation, the way ADR-EA-007 accepts it for Effect v4 generally — in exchange for one uniform configuration mechanism across every plugin rather than a bespoke, per-plugin options-merging scheme. Should `Context.Reference`'s semantics shift before v4 stabilizes, the blast radius is every plugin's configuration surface at once, a cost this ADR accepts under the same umbrella ADR-EA-007 already carries for v4 generally, but one this document had not, until now, named as its own specific instance of that risk.

Not yet implemented — see spec/roadmap.md for milestone.
