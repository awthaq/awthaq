# ADR-EA-005: Static Composition

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-005 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — design; implementation deferred |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Strengthened "Alternatives considered" with OSGi's dynamic service registry as a real, grounded competing precedent (CCR-EA-002) <br> 1.2 (2026-09-29): Replaced "Not yet implemented" with a pointer to ADR-EA-018 (EP-001) |

---

## Context

better-auth resolves its entire plugin set at `betterAuth(options)` construction time; there is no runtime enable/disable of installed plugins, and the only place runtime-conditional behavior exists is inside *option-level functions* — `trustedOrigins(request)`, `accountLinking.trustedProviders(request)`, `allowUserToCreateOrganization(user)` — that are evaluated per-request against an otherwise fixed plugin set (research/02-better-auth.md Q30). awthaq's own design (PRD §9.4, `archive/design/plugins-as-layers.md` §4) needs the same property for a stronger reason than better-auth has: because the plugin set determines the shape of the merged `HttpApi` contract (ADR-EA-003) and the shape of the composed Layer's `RIn`/`ROut` (ADR-EA-001, ADR-EA-002), the plugin set is a *type-level* fact, not merely a configuration value. If the set of installed plugins could change at runtime, the type of `auth.api` and `auth.layer` could not be known at compile time, and none of the compile-time guarantees ADR-EA-002 relies on (missing dependency named by `Auth.make`, slot conflicts refused, contract/handler pairing enforced) would be possible — they all depend on `Auth.make([Password, Passkey, OAuth, ...])` being evaluated once, over a fixed tuple, before the program runs.

## Decision

The plugin set passed to `Auth.make` is fixed at composition time and is not runtime-reconfigurable: `Auth.make([Password, Passkey, OAuth, Organization, Roles])` (PRD §9.4) produces `api`, `layer`, `migrations`, and `manifest` as one static computation over that tuple. Everything that must vary at runtime — per-tenant configuration, feature flags, per-request provider selection — is expressed *within* an already-installed plugin's Layer via `Config`, `Context.Reference` (ADR-EA-011), or `LayerMap.Service` for keyed/per-tenant resources (`archive/design/plugins-as-layers.md` §3.1's `TenantAuthConfig` example), never by adding or removing plugins from the tuple after `Auth.make` has run. This is the load-bearing separation behind ADR-EA-006: installation (which plugins exist, statically) and configuration (how an installed plugin behaves, which may vary per request or tenant) are different axes, and only the second is runtime-dynamic.

## Alternatives considered

**Runtime-registerable plugins**, i.e. an `Auth` instance that accepts plugin registration after construction (a pattern the PRD's own research survey found precedent for only in the option-level-function sense — better-auth's `trustedOrigins(request)`-style callbacks — never as true dynamic install/uninstall of a plugin's endpoints, tables, or schema contributions; research/02-better-auth.md Q30 notes explicitly that "there is no runtime enable/disable of installed plugins" even in better-auth). Runtime plugin registration was never seriously pursued for awthaq because it is fundamentally incompatible with a typed contract (ADR-EA-003) and a compile-time-validated dependency graph (ADR-EA-002): the type of `auth.api`/`auth.layer` would have to be either erased to something dynamic (losing every static guarantee) or recomputed and re-checked at runtime (reintroducing the hand-written linker ADR-EA-002 exists to avoid).

A genuinely dynamic alternative *does* exist in the wider plugin-platform literature, and it is worth naming rather than implying no real precedent exists at all: **OSGi's dynamic service registry**, which `research/14-plugin-platforms.md` documents as the module system Eclipse's own plugin architecture was rebuilt on top of — "bundles, import/export matching by version ranges, dynamic service registry," per the OSGi Core Release 8 Specification entry in that file's annotated bibliography, with bundles installable, startable, and uninstallable at runtime against a live service registry. This is a real, working precedent for hot plugin registration, not a strawman — and awthaq's own research corpus cites it approvingly elsewhere, for the "extensions vs services" architectural split (`research/14-plugin-platforms.md`: "extensions address the extensibility of a component, services address interoperability," Gruber et al. 2005). It was not adopted for the plugin *set* itself because OSGi's dynamism is bought with a materially different foundation than awthaq's: bundle import/export matching is resolved by *version ranges checked at runtime*, against a service registry whose shape is not statically known to any one bundle's compiler — exactly the reintroduced runtime linker/re-check this ADR's Decision section rules out, and exactly the kind of dynamic, non-type-checked composition ADR-EA-002's compile-time guarantees depend on not existing. Eclipse's own empirical record, also from `research/14-plugin-platforms.md` (Businge et al., ICSM 2012), is the caution this project weighs against that dynamism: plugins built against undeclared or unstable parts of a large, runtime-resolved surface survived forward compatibility at only 50.2%, against 96.7% for plugins that stayed within a small, disciplined contract — evidence that a dynamic, runtime-resolved plugin surface is not free even where it is achievable, and that a smaller, statically-checked one (this ADR's choice) trades away OSGi's runtime flexibility specifically to avoid that failure mode.

## Consequences

**Positive**: Every guarantee `Auth.make`'s `Validate<P>` and `Layer.launch` provide (ADR-EA-002) is available specifically because the plugin tuple never changes after composition — a missing dependency, a slot conflict, or an unsatisfied port is caught before the process starts serving traffic, not discovered mid-flight after a runtime registration call. The merged `HttpApi` contract, and therefore every derived client, is stable for the lifetime of the process.

**Negative**: Use cases that genuinely want to toggle a sign-in method or plugin's *presence* at runtime (as opposed to its configuration) — e.g. an operator wanting to disable OAuth without redeploying — are not supported directly; the closest approximation is a plugin-internal `Config`-backed feature flag that makes an installed plugin's endpoints return a typed "disabled" error, which is a configuration-layer workaround, not true uninstallation.

**Trade-off accepted**: awthaq gives up "hot" plugin registration/deregistration — a capability some deployments might want for operational flexibility — in exchange for a plugin set whose composition is fully checked by the type system before the application runs, which the project judges to be worth more than runtime flexibility given how much of the rest of the design (ADR-EA-001 through ADR-EA-003) depends on the plugin tuple being fixed and known statically.

The keyed/per-tenant seam this ADR reserves is realized by [ADR-EA-018](018-tenancy-is-an-organization.md): a tenant is an `Organization` row, carried as an ambient `TenantContext` and an opaque `"tenantId"` column, with per-organization OAuth connections and configuration as `LayerMap.Service`s. The plugin set itself remains static.
