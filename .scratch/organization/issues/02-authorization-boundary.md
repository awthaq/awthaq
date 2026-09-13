# 02 — Authorization boundary: gating Organization's own endpoints and wiring the qadi RelationshipResolver

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately (grounded in ticket 00 and the map's own charting decisions)

## Question

`Organization` cannot override the exclusive `SubjectResolver` slot
(BEH-EA-138, already owned by `Roles`), and — mirroring `Admin`'s own
resolved precedent — cannot depend on `@effect-auth/qadi` directly (stratum
ordering: plugins sit below qadi in `spec/overview.md`'s stratum table). Yet
this map's own charting decision says Organization's own endpoints
(member-role changes, dynamic-role management, invitations, team
management) should themselves be gated by qadi-built policies, not a
second bespoke access-control engine.

Resolve concretely:

1. What does "gated by a qadi-built policy" actually mean mechanically for
   an endpoint living in a plugin that can't import qadi? (Likely shape,
   mirroring `Admin`'s `AdminConfig.canImpersonate`: a config-supplied
   predicate/policy function over a bare `@qadi/core` `AuthSubject`, built
   by the *application* using real qadi machinery and injected via
   `OrganizationConfig` — confirm or refine.)
2. Is one config predicate enough for every gated operation (create org,
   delete org, remove member, update member role, manage dynamic roles,
   invite/cancel/accept invitation, team CRUD), or does full feature
   richness demand a predicate-per-operation-class (e.g. one for
   membership changes, one for dynamic-role management, one for team
   management)?
3. How does the `RelationshipResolver` contribution (the `"member"`/
   `"team-member"` relations) actually get registered into the real
   `QadiLive` layer an application builds — is there already a resolver
   registry/slot in `packages/qadi/src` this plugs into, or does this need
   new wiring? Read `packages/qadi/src`, `spec/behaviors/19-21` before
   grilling — this may already be substantially specified.
4. Does a dynamic per-org role's custom `permission` field (ticket 05)
   ever reach qadi as data (e.g. a resource/subject attribute a policy can
   read), or does it stay purely internal to gating Organization's own
   endpoints per (1)/(2)?

## Answer

Resolved directly by `/to-spec`, folded into `.scratch/organization/spec.md`'s
"Implementation Decisions" (§ Roles & permissions — a self-contained,
statement-based engine; § qadi contribution). Summary: `Organization` ships
its own self-contained, statement-based permission engine (matching
better-auth's own `hasPermission` shape) to gate its own endpoints — no
qadi dependency, no bespoke predicate-injection config needed, functional
out of the box. Separately, it contributes two ordinary qadi `Layer`s —
`Organization.relationships` (`RelationshipResolver`, extending the
already-locked `BEH-EA-162`) and a new `Organization.attributes`
(`AttributeResolver`) — so *application*-level policies can combine
organization data with other qadi concerns. A dynamic role's custom
`permission` field is checked by the same internal statement engine (not
separately exposed to qadi) and cannot self-escalate beyond the creator's
own resolved permissions.
