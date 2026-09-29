# ADR-EA-009: Authorization Is Delegated to Qadi

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-009 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Status flipped from "design; implementation deferred" to implemented — the decision is visible in `packages/` (AVS-008, DTWS-001, CCR-EA-006) |

---

## Context

PRD §15 states the boundary directly: "awthaq ships no permission model, no policy language and no authorizer. It ships the bridge to qadi." Authentication (who is this principal) and authorization (what may this principal do) are distinct problems with distinct maturity requirements. `research/08-authorization.md`'s survey frames the boundary precisely: "An auth *library* should own: principal abstraction, typed permission registry, check/require plumbing, ownership rules, error typing, deny logging. It should **delegate** (via one capability interface): relationship-graph storage, policy DSL parsing, policy distribution, reverse-index list queries — these are what SpiceDB/OpenFGA/Cedar/OPA do" (TL;DR). Building a policy DSL, a relationship-graph store, and a general authorizer well is a substantial, ongoing engineering commitment in its own right — the same research explicitly warns against it: "Do **not** build a policy DSL. Type the registry in TypeScript; if richer policy text is ever needed, adopt/borrow Cedar rather than inventing syntax (Oso's DSL-turned-deprecated-library is the cautionary tale)" (Q64), and recommends that anything beyond a typed permission registry and check plumbing be explicitly out of scope: "relationship-tuple storage, reverse-index list queries over app data, policy distribution plane (OPAL-style), policy DSL/parser, policy-as-WASM — delegate to Cedar/OPA/SpiceDB/OpenFGA/Permit via the `Authorizer` seam" (Recommended defaults, item 11).

An earlier design iteration sketched exactly the kind of first-party authorizer this research warns against — a permission registry, a policy DSL, and an `Authorizer` service built and maintained inside awthaq itself (the shape implied by PRD §15's phrasing "no permission model, no policy language and no authorizer" is a direct rejection of that earlier sketch, and the research's Oso citation — "Oso's DSL-turned-deprecated-library" — is offered as the cautionary tale for exactly this path). Given a sibling project, qadi, already exists to be awthaq's authorization engine (PRD §15, §8's stratum 6), and given the research's own conclusion that authorization done well is a substantial, separate discipline, awthaq's correct scope is the *bridge*: resolving a `Subject` from authenticated session/account data, and letting qadi own everything downstream of that subject.

## Decision

awthaq defines **no permissions, no policies, and no authorizer**. It ships exactly the `SubjectResolver` slot (a `Context.Reference`, ADR-EA-012, defaulting to identity-only resolution, overridden by plugins such as `Roles` which flattens role-table data through a qadi role DAG, or `Organization`/`ApiKey` which contribute attributes and scopes) and two integration paths into qadi: **Path A**, an `AuthorizedSubject` middleware that requires `CurrentPrincipal` and provides qadi's `CurrentSubject`, letting handlers use qadi's own `guard`, `enforce`, `enforceProjected`, `filter`, `decide`; and **Path B**, a `SubjectExtractor` layer that runs awthaq's session resolution on the raw request so that qadi's `RequirePermission` can enforce `requiresPermission` annotations directly, with unannotated endpoints refused by default (PRD §15). awthaq additionally supplies qadi with resolvers built from data it already owns — attributes from the user table, relationships from organization membership, decision history from the audit event stream — and discharges qadi's step-up obligations (e.g. `ObligationHandlers.reauth`) using session freshness it already tracks. The rules governing this boundary are qadi's, adopted as-is by awthaq's bridge code: "failure is not denial (502 vs 403); absence is refusal; decide against attributes, not content; a stale decision is not a decision; one evaluation path" (PRD §15).

## Alternatives considered

**A first-party authorizer, permission registry, and policy DSL built and maintained inside awthaq**, the path an earlier design iteration sketched and which `research/08-authorization.md` surveys and explicitly recommends against: building relationship-graph storage, a policy language/parser, and a distribution plane in-house rather than adopting an existing engine (Cedar, OPA, SpiceDB, OpenFGA) via a capability seam. This was rejected on cost-of-ownership grounds the research states plainly: authorization-specific concerns like ReBAC relationship storage and policy DSLs are what dedicated engines like SpiceDB/OpenFGA/Cedar/OPA exist to do well, and reinventing them inside an authentication library would mean awthaq competing with, rather than integrating, mature prior art — with the DSL specifically flagged as a historical failure mode ("Oso's DSL-turned-deprecated-library is the cautionary tale").

## Consequences

**Positive**: awthaq's own scope stays bounded to what an authentication library should own — principal resolution, session/credential handling, and a typed bridge — while authorization logic benefits from qadi's dedicated engineering investment (schema-derived policy ADTs, obligations, SQL-pushdown predicates) rather than a second, less mature implementation inside awthaq. Applications get two integration styles (Path A/B) rather than being forced into one, and awthaq's audit trail composes directly with qadi's `DecisionSink`.

**Negative**: Applications that want any authorization at all must adopt a second library (qadi) and understand its own concepts (subjects, obligations, resolvers, the two integration paths) — awthaq alone provides no meaningful access control beyond "is this principal authenticated." The `SubjectResolver` slot is exclusive (ADR-EA-012), so only one plugin may own subject resolution, which constrains how role- and organization-membership-derived authorization data can be composed without one plugin depending on and wrapping the other.

**Trade-off accepted**: awthaq gives up being a self-contained authentication-and-authorization solution — a property some competing libraries (with their own, more limited RBAC plugins) do offer out of the box — in exchange for not carrying the long-term maintenance burden of a policy engine, and in exchange for whatever authorization it does support being as capable as qadi is, rather than as capable as an authentication team's part-time authorization effort would be.

Database-level isolation is defence in depth, not this control: [ADR-EA-018](018-tenancy-is-an-organization.md)'s opt-in Postgres row-level security under the `"tenantId"` column is a backstop for a forgotten application filter, and authorization decisions still belong to qadi. A migration from Supabase keeps its RLS through the qadi rollout and retires it only once qadi covers every data path (`packages/sql/README.md`, "Multi-tenancy").
