# ADR-EA-006: Runtime Configuration Is Separate From Installation

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-006 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-12 |
> | Status | Accepted — design; implementation deferred |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Sharpened the Negative consequence to name the missing config-listing/validation tooling explicitly (CCR-EA-002) <br> 1.2 (2026-09-29): Replaced the accepted "no config listing / validation" gap with statically declared configuration descriptors, a `config list` command and a runtime `EffectiveConfig.snapshot` (ECS-008, EP-009, CCR-EA-006) |

---

## Context

ADR-EA-005 fixes the plugin *set* statically at `Auth.make` time. That leaves open a distinct question: how does an installed plugin's *behavior* vary — per environment, per tenant, per test — without touching the plugin set itself or requiring a rebuild of the composed `Layer`? better-auth conflates the two axes: plugin options are passed as constructor arguments at `betterAuth(options)` time, mixed in with the plugin list itself, so varying a password policy's minimum length per tenant means either re-constructing the entire `betterAuth` instance or threading option overrides through request-scoped callbacks (`trustedOrigins(request)`, `allowUserToCreateOrganization(user)`, research/02-better-auth.md Q30) that exist alongside, but not uniformly with, the rest of the configuration surface. `research/01-effect-ecosystem.md` Q30's recommendation is explicit that these two concerns want different mechanisms: "keep the PRD's two-graph separation — the Layer graph is static; runtime config is a `Config`/`Ref`-backed service consumed by capabilities ... Multi-tenancy later slots in as `LayerMap` without changing the plugin contract."

## Decision

Installation (which plugins exist — ADR-EA-005) and configuration (how an installed plugin behaves) are handled by two different mechanisms. Installation is the fixed tuple passed to `Auth.make`. Configuration is realized as `Context.Reference` overrides (ADR-EA-011: a plugin's options are a service with a default, not constructor arguments) composed via `Layer.provide`, and, where configuration must vary *per key* at runtime (per tenant, per request-scoped identity) rather than merely per deployment, as `LayerMap.Service` (`archive/design/plugins-as-layers.md` §3.1's `TenantAuthConfig` example: `LayerMap.Service<TenantAuthConfig>()("app/TenantAuthConfig", { lookup: (tenant) => Layer.mergeAll(Password.config(tenantPolicy(tenant)), Sessions.config({ idle: tenantIdle(tenant) })), idleTimeToLive: "10 minutes" })`). A missing configuration override is never an error — the `Context.Reference`'s default value applies — while a *malformed* override is a compile-time type error against the reference's declared shape, not a runtime validation failure discovered after the application has started.

## Alternatives considered

**Configuration passed as constructor options alongside plugin installation**, better-auth's model, where a plugin factory's options and the fact of the plugin's presence are established in the same call (`password({ minLength: 12 })` both installs the plugin and fixes its configuration for the lifetime of the `betterAuth` instance; per-request variation is bolted on afterward as ad hoc callback options rather than a uniform mechanism; research/02-better-auth.md Q30). This was rejected because it makes per-tenant or per-environment reconfiguration require either re-running the entire composition (defeating the point of composing once, per ADR-EA-005) or a second, inconsistent callback-based configuration surface that coexists uneasily with the primary one.

## Consequences

**Positive**: Configuration can be swapped per test, per tenant, or per environment using the same Layer-provision mechanism as everything else in the system (`Layer.provide(Password.config({ minLength: 16 }))`), with no distinction in kind from providing a port implementation; multi-tenant configuration is `LayerMap` composed over the same `Context.Reference`, requiring no change to the plugin's contract or to `Auth.make`'s validation.

**Negative**: Configuration values are still not part of the statically derived manifest (ADR-EA-005), so an override that is computed dynamically — per request, or per tenant through a `LayerMap` — cannot be listed or validated before deploy; only a configuration Layer that is built on its own, with no ports and no database, exposes the values it sets. An operator debugging a per-tenant override still has to run the application (or `EffectiveConfig.snapshot` inside that tenant's scope) to see what applies.

**Mitigation (revision 1.2)**: the original revision accepted having no artifact that lists "every configuration value this application has set" and no config-validation tooling. That trade-off was resolved toward the richer option. A plugin (or a core service) declares its configuration inputs as *descriptors* — the `Context.Reference` carrying them, which keys hold secrets, and an audit of a value against the insecure-default rules — and `Auth.make` exposes them as `auth.manifest.config`, derived without evaluating any Layer, so the *shape* of configuration is part of the static manifest while the *values* remain ordinary `Layer.provide` overrides (the mechanism this ADR chose is unchanged). `awthaq config list` and `awthaq doctor` (BEH-EA-201, BEH-EA-229) read the descriptors plus a configuration Layer the application's `awthaq.config.ts` exports, and a running application can dump its effective configuration through `EffectiveConfig.snapshot`. Sensitive values are rendered `<redacted>` in every one of those outputs and never unwrapped.

**Trade-off accepted**: awthaq keeps configuration overrides expressed through exactly the same primitive (`Layer.provide`) as every other kind of composition, with no "options merging" subsystem, and pays for the operability gap with a small declarative descriptor per configuration reference instead of a second, separately maintained configuration manifest. A descriptor cannot drift from the reference it wraps (it holds the reference itself), so the listing is what the application reads, not a description of it. What remains uncovered is the dynamic-override case above.

Implemented for the configuration *listing*: `ConfigDescriptor`/`EffectiveConfig` and `manifest.config` in `@awthaq/core`, `awthaq config list` and `doctor` in `@awthaq/cli`, `GET /admin/config` in `@awthaq/admin` (BEH-EA-229). The separation itself (installation versus configuration as `Context.Reference` overrides) was already in place.
