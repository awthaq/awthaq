# ADR-EA-040: A Plugin May Expose Namespaced Domain Services; Dependents Declare `dependsOn`

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-040 |
> | Revision | 1.1 |
> | Effective Date | 2026-11-09 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-13): Initial release (plan 04) <br> 1.1 (2026-11-09): decision 6, the authorized interface authorizes through one primitive; ceilings are minted only by `OrganizationAuthority` (plan 30 Part A) |

---

## Context

`@awthaq/organization` is one module with one wide interface: every operation needs an `Api.UserPrincipal` and mixes the domain invariants (owner rule, quotas, the team forest, cascades, transactions, hook points, events) with authorization (membership visibility, statement checks, the caller's grant ceiling). Trusted callers have no way to use the invariants without a principal, so they bypass the module and write its records: SCIM recreated `removeTeam`'s cascade and dropped the veto, the transaction, `teams.enabled`, `maximumTeams`, the events and the after-hooks; AdminTenants flipped `suspendedAt` through the records, so no observe point ever fired and a long-lived `DecisionCache` kept stale answers.

The fix is a layer of **system interfaces** beneath the authorized one (`OrganizationTeams`, `OrganizationMembers`, ...), each taking an explicit actor. Another plugin can only reach them if the organization plugin's layer provides them, and [ADR-EA-001](001-plugins-contribute-layers.md) / [ADR-EA-002](002-plugin-graph-read-off-service-graph.md) require that dependency to be read off the Layer graph, never configured on the side. Until now a plugin layer's `ROut` was its own service plus its HTTP groups, and [ADR-EA-010](010-plugins-require-ports-never-provide.md) forbids providing a port.

## Decision

**1. `AuthPlugin.layer(Self, { exposes: { services, layer } })`.** A plugin may expose **namespaced domain services** beside its own service. `services` lists the tags (static, so the manifest prints them without building a layer); `layer` builds them once, beneath `make`, so `make` may require them. They join the plugin layer's `ROut`, and `Auth.make`'s left fold (`provideMerge`, dependencies first) discharges a dependent's requirement on them.

**2. The namespace rule.** Every exposed service's key is `awthaq/plugin/<id>/<name>`. `ExposesComplete` is a compile-time check mirroring `PortsComplete`: a key outside the plugin's own namespace, a service the layer provides but `services` does not list, or the reverse, each make `exposes` a required property whose type names the offending keys. Two plugins can therefore never expose the same tag, and no implicit slot appears.

**3. `Validate<P>` gains a fifth problem, `ExposerNotDependedOn`.** A plugin whose layer requires `awthaq/plugin/<id>/<name>` must also require `awthaq/plugin/<id>`, which is exactly what `dependsOn: [Exposer]` adds to its `RIn`. Otherwise the tuple is refused: `plugin "scim" requires a service exposed by "organization" — add organization to dependsOn`. `MissingDep` and `OutOfOrderDep` read an exposed service as a dependency on its exposer (`IdOf` keeps the segment before the `/`).

**4. The manifest.** `Manifest.exposes` lists `{ plugin, key }` in link order; `awthaq plugin list --graph` prints an `exposes:` line. JH-008 is untouched: a plugin still may not provide a port, and an exposed domain service is not one (a port key is `awthaq/ports/...`).

**5. First user.** `Organization.layer` exposes its system modules. SCIM, SAML and AdminTenants require them through the Layer type and never the records.

**6. The authorized interface authorizes through one primitive (revision 1.1).** Every organization-scoped method of `Organization` obtains an access proof from the package-private `OrganizationAccess` (`internal/access.ts`) before it calls a system interface. A proof is minted in one fixed order, written once per entry point:

1. the organization is active (EP-003);
2. the caller is a member (MTI-009; a statement-gated entry publishes `auth.organization.permissionDenied` `notMember`);
3. the feature gate (PV-300: after membership, so a non-member's answer never depends on a feature);
4. the statement, held in the caller's statements in scope (`OrganizationAuthority.scopedStatements`; `missingStatement` on a miss).

The proof is branded and minted only by that module. It carries the organization id, the `User` actor and, for a statement, the ceiling the caller may confer. A `Bound.Ceiling` is minted only by `OrganizationAuthority`: a proof's ceiling, or `ceilingOf` for an identity provider. So a role-conferring call on behalf of a member cannot be made without the statement check that produced its ceiling. A 41-entry policy table (`internal/policy.ts`, complete against `OrganizationShape` by its type) is the oracle of a generated authorization-matrix suite, and a static guard keeps every authorization step out of `Organization.ts`. System interfaces still take an `Actor` and never authorize (decision 5 unchanged), because trusted callers have no principal to prove. The organization's own endpoints are still gated by its `PermissionEngine` ([ADR-EA-025](025-global-roles-vs-organization-roles.md)), not by qadi.

## Consequences

**Positive**: a trusted caller gets an interface that owns its invariants, hooks, events and transactions; the dependency is checked by the compiler and visible in `plugin list --graph`; a module can be tested or substituted alone. A system module's invariant over several rows is enforced by a record-store primitive ([ADR-EA-041](041-domain-store-ports.md) decision 9); the module's own check only orders errors.

Decision 6: the order MTI-009 depends on is written once, so a new endpoint chooses *what* it needs and cannot reorder *how* it is checked; a role-conferring call's ceiling is the one its check read.

**Negative**: one option on `AuthPlugin.layer` and one `Validate` rule to maintain. An inline `Layer.succeed(Tag, ...)` as the sole `exposes.layer` does not infer (TypeScript fixes the contravariant `ROut` parameter to `never` while it is still contextually typed); bind the layer to a `const` or build it with `Layer.mergeAll`.

## Alternatives considered

- **(a) The application provides the system layer itself, as it does records.** Needs no core change, but it is a second thing to wire, the plugin and its dependents could be given different instances, and the plugin graph could not see the dependency (ADR-EA-002).
- **(b) Hang the system interfaces off the plugin shape (`organization.system.teams`).** Needs no core change, but a dependent would depend on the whole authorized interface, a module could not be substituted alone, and the shape would become the wide interface again.
- **(c) `exposes`**, chosen: type-checked, read off the Layer graph, one option plus one `Validate` rule.

For decision 6 (plan 30 §3.A.9): **(a)** three hotfixes and stop (the next endpoint repeats the hazard); **(b)** a combinator that builds each method from its policy entry (custom flows need escape hatches, and typing it needs conditional return types); **(c)** system interfaces require the proof (trusted callers have no principal, and it reverses decision 5); **(d)** gating through qadi (plan 04 decided no). Chosen: one package-private module with typed entry points, a branded proof, a compiler-owned ceiling and a table-driven matrix. Its consequences: one more package-private module; `OrganizationActor.user` removed; `Bound.Ceiling` not constructible outside the package.

## Related

[ADR-EA-001](001-plugins-contribute-layers.md), [ADR-EA-002](002-plugin-graph-read-off-service-graph.md), [ADR-EA-010](010-plugins-require-ports-never-provide.md), [ADR-EA-012](012-slots-exclusive-registries-aggregate.md), [BEH-EA-329](../behaviors/02-plugin-composition-validate.md).
