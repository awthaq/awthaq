# ADR-EA-044: The Servable Composition Is Derived From `Auth.make` by One Host Module; the Host Provides Only What It Owns

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-044 |
> | Revision | 1.0 |
> | Effective Date | 2026-11-08 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-11-08): Initial release (architecture plan 15) |

---

## Context

`Auth.make` returns `api`, `layer`, `plugins`, `migrations`, `userFieldsLayer` and the rest, but nothing turned that value into something a host can serve. The host assembled, by hand and in the right order, the routes with core's `session`/`account` handlers, every composed plugin's `records` bundle and declared `hookPoints`, core's services over `Persistence.memory` or `Persistence.sql()`, the registries (`Hooks.HooksLive`, `RateLimits.layer`, `Slots.layer`, `Credentials.CredentialResolversLive`), the host middleware the groups declare, `built.userFieldsLayer` and, over SQL, core's migrations and then `built.migrations`.

Only `TestAuth.layer` did all of it. The two examples and the README quickstart each re-derived a subset, and the SQL copies were wrong in a way the compiler could not see. The type system guards most of the list: a missing record store, hook point, port or middleware stays in `RIn`. It does not guard two items, because they are not services: the migrations (an effect someone must run) and the user-field registry (a `Context.Reference` with an empty default). Adding a table-owning plugin to the SQL example the way its own comment said type-checked with `RIn = never` and answered `503 StoreUnavailable` (`no such table: organization_membership`) for every request to it. A boot-time migration run (`Migrator`, then `Migrations.run`) also had none of the CLI's ledger-drift refusal, so a plugin inserted before an applied one was silently skipped.

## Decision

**1. One module, `AuthHost.layer`, in `@awthaq/server`.** The server already depends on core and owns `AuthHttp` and the middleware; no new package.

**2. The composition-owned / host-owned split.** An element is composition-owned when it is a pure function of the plugin tuple, or a registry the composition must hold exactly once (ADR-EA-033): routes for `api`/`publicApi`/`adminApi` (`tier`), core's handlers, `built.layer`, each plugin's `records[mode]` and `hookPoints`, core's services over the chosen store bundle, the registries, `AuthHttp.middlewareFor(built.api)` and the resolver, `built.userFieldsLayer`, the migrations, and the `RequestContext.layer`/`BodyLimit.layer` edge middleware (dials, on by default). Everything else is host-owned (ADR-EA-010): the persistence choice and its `SqlClient`, the CSRF secret, an optional principal resolver, host services and taps, and every port, adapter and platform service.

**3. `RIn` is exactly the host-owned remainder.** `persistence` and `csrf` are required options, and with `records: "sql"` so is `migrations`; there is no silent default for a choice only the host can make. A missing port is a compile error at `Layer.launch` (BEH-EA-014, BEH-EA-340).

**4. SQL mode runs or verifies the migrations inside the client's only path.** The client reaches the stores, the plugins' `records.sql` and everything above only through a layer that first runs `Migrations.onBuild(mode, built.migrations)`: `"apply"` brings the schema current, `"verify"` refuses the build when anything is pending. Both refuse a drifted ledger. The runner is core's `Migrations.apply`/`verify`, which `awthaq migration apply` also uses (BEH-EA-039, BEH-EA-204, BEH-EA-341).

**5. Declared hook points are provided in production**, once, beneath the host's `taps`, in the same layer graph, closing ADR-EA-033's "a tap built in a different layer graph has no effect" hazard for every host on the module. This reverses plan 08's decision that points are provided only by the harness.

**6. `TestAuth.layer` is this module over the test ports**, the redaction guard and the HTTP platform, so the harness and a production host share every composition-owned element by construction (BEH-EA-342).

## Alternatives considered

- **A `serve`/`layer` member on `Auth.Built`.** Rejected: `@awthaq/core` cannot depend on `@awthaq/server`, and the built value would have to carry a persistence choice.
- **A recipe in the docs.** Rejected: the hand-written copies already were recipes, and they drifted.
- **Separate exported pieces (`AuthHost.base`, `AuthHost.records`, `AuthHost.points`) the host composes.** Rejected: shallow; the order is the hard part.
- **Defaulting `migrations` to `"apply"`.** Rejected: which process migrates is a deployment decision, and the type-system-first rule makes the host say it.
- **A "batteries" variant that also provides default ports.** Rejected: ADR-EA-010; a missing `Mailer` must stay a compile error.
- **A new `@awthaq/host` package above the server.** Rejected: the server already owns the pieces, and a package would add an edge for no new capability.
- **A route-less `AuthHost.application` for CLI commands and workers.** Not added: `AuthHost.layer(...)` with `HttpRouter.layer` provided serves them; the routes register on a router nobody serves at negligible cost.

## Consequences

**Positive**: one derivation instead of four; the SQL example serves a table-owning plugin; a boot-time migration run refuses drift; the user-field registry and the declared hook points cannot be forgotten; a host's code shrinks to its ports, persistence, secret and policy layers.

**Negative**: `RequestContext.layer` and `BodyLimit.layer` are on by default, so a host that served a large-body route on the same router must pass `bodyLimit: false` or raise `BodyLimit.config`. `"apply"` on every replica migrates at boot unless the host chooses `"verify"`. For a key both `services` and the composition provide, the plugins see the `services` instance while the output holds the composition's (plan 08's measured semantics); `decorate` replaces a composition-owned service for everyone.

## Related

[BEH-EA-014](../behaviors/02-plugin-composition-validate.md#beh-ea-014-layerlaunch-refuses-to-compile-while-any-port-remains-unprovided), [BEH-EA-340](../behaviors/02-plugin-composition-validate.md#beh-ea-340-authhostlayer-derives-the-servable-layer-from-authmake-and-its-requirements-are-exactly-what-the-host-owns), [BEH-EA-341](../behaviors/05-persistence-stratum.md#beh-ea-341-a-sql-host-composition-never-serves-a-schema-that-is-behind-it), [BEH-EA-039](../behaviors/05-persistence-stratum.md#beh-ea-039-schema-diffing-snapshot-comparison-and-destructive-change-guardrails-are-a-deferred-cli-feature-not-a-v1-runtime-requirement), [BEH-EA-204](../behaviors/26-cli.md#beh-ea-204-migration-status-and-apply-read-and-advance-the-ledger), [ADR-EA-010](010-plugins-require-ports-never-provide.md), [ADR-EA-033](033-hook-registries-per-composition.md), [ADR-EA-035](035-user-field-extension-point.md), [ADR-EA-041](041-domain-store-ports.md).
