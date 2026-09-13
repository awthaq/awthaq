# ADR-EA-006: Runtime Configuration Is Separate From Installation

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-006 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | effect-auth Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Sharpened the Negative consequence to name the missing config-listing/validation tooling explicitly (CCR-EA-002) |

---

## Context

ADR-EA-005 fixes the plugin *set* statically at `Auth.make` time. That leaves open a distinct question: how does an installed plugin's *behavior* vary — per environment, per tenant, per test — without touching the plugin set itself or requiring a rebuild of the composed `Layer`? better-auth conflates the two axes: plugin options are passed as constructor arguments at `betterAuth(options)` time, mixed in with the plugin list itself, so varying a password policy's minimum length per tenant means either re-constructing the entire `betterAuth` instance or threading option overrides through request-scoped callbacks (`trustedOrigins(request)`, `allowUserToCreateOrganization(user)`, research/02-better-auth.md Q30) that exist alongside, but not uniformly with, the rest of the configuration surface. `research/01-effect-ecosystem.md` Q30's recommendation is explicit that these two concerns want different mechanisms: "keep the PRD's two-graph separation — the Layer graph is static; runtime config is a `Config`/`Ref`-backed service consumed by capabilities ... Multi-tenancy later slots in as `LayerMap` without changing the plugin contract."

## Decision

Installation (which plugins exist — ADR-EA-005) and configuration (how an installed plugin behaves) are handled by two different mechanisms. Installation is the fixed tuple passed to `Auth.make`. Configuration is realized as `Context.Reference` overrides (ADR-EA-011: a plugin's options are a service with a default, not constructor arguments) composed via `Layer.provide`, and, where configuration must vary *per key* at runtime (per tenant, per request-scoped identity) rather than merely per deployment, as `LayerMap.Service` (`archive/design/plugins-as-layers.md` §3.1's `TenantAuthConfig` example: `LayerMap.Service<TenantAuthConfig>()("app/TenantAuthConfig", { lookup: (tenant) => Layer.mergeAll(Password.config(tenantPolicy(tenant)), Sessions.config({ idle: tenantIdle(tenant) })), idleTimeToLive: "10 minutes" })`). A missing configuration override is never an error — the `Context.Reference`'s default value applies — while a *malformed* override is a compile-time type error against the reference's declared shape, not a runtime validation failure discovered after the application has started.

## Alternatives considered

**Configuration passed as constructor options alongside plugin installation**, better-auth's model, where a plugin factory's options and the fact of the plugin's presence are established in the same call (`password({ minLength: 12 })` both installs the plugin and fixes its configuration for the lifetime of the `betterAuth` instance; per-request variation is bolted on afterward as ad hoc callback options rather than a uniform mechanism; research/02-better-auth.md Q30). This was rejected because it makes per-tenant or per-environment reconfiguration require either re-running the entire composition (defeating the point of composing once, per ADR-EA-005) or a second, inconsistent callback-based configuration surface that coexists uneasily with the primary one.

## Consequences

**Positive**: Configuration can be swapped per test, per tenant, or per environment using the same Layer-provision mechanism as everything else in the system (`Layer.provide(Password.config({ minLength: 16 }))`), with no distinction in kind from providing a port implementation; multi-tenant configuration is `LayerMap` composed over the same `Context.Reference`, requiring no change to the plugin's contract or to `Auth.make`'s validation.

**Negative**: There is no single artifact that lists "every configuration value this application has set," and this is a real operational gap, not a stylistic nit. Because each plugin's options live in its own `Context.Reference`, overridden by whatever `Layer.provide` calls an application's composition root happens to contain, an operator who wants to answer "what is `Password`'s `minLength` in production, and did someone override `Sessions`' idle timeout for this tenant" has to read the composition code itself — there is no `effect-auth config list` or equivalent (nothing resembling it appears anywhere in file 26's CLI surface), no config-validation-CLI story that could catch a malformed override before deploy the way `Layer.launch`'s type-checking catches a missing port, and no runtime introspection endpoint that dumps effective configuration the way `plugin list --graph` (BEH-EA-202) dumps effective plugin topology. Every other structural fact about a composed application — its plugin graph, its hook chains, its routes — is introspectable per file 26; configuration, chosen specifically because it is *not* part of that statically-derived manifest (ADR-EA-005), is consequently the one axis of an application's behavior that CLI tooling in this specification has no answer for.

**Trade-off accepted**: effect-auth accepts the absence of a single "list all configuration" artifact and of any config-validation-CLI story — an operator debugging unexpected plugin behavior in production has strictly less tooling to inspect *why* than they have to inspect *what is installed* — in exchange for configuration overrides being expressed through exactly the same primitive (`Layer.provide`) as every other kind of composition in the system, with no special-cased "options merging" or "config manifest" subsystem to build and keep in sync with whatever the composition code actually contains. This is a real, current gap in operability, not merely "a small additional indirection" — it is accepted because building the missing tooling would mean either reintroducing a statically-derived configuration manifest (the very thing ADR-EA-005 keeps out of the type-checked plugin graph) or shipping a second, separately-maintained description of configuration that could drift from what `Layer.provide` calls actually do.

Not yet implemented — see spec/roadmap.md for milestone.
