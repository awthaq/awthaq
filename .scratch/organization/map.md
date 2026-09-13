# Organization plugin — full better-auth feature parity

## Destination

A locked `spec/behaviors/` file (new `BEH-EA` range) plus resolved design
decisions for a full-featured `Organization` plugin — organizations,
per-membership + dynamic per-org roles, teams, an extensible
permission/access-control system, complete invitation lifecycle, lifecycle
hooks, and a qadi `RelationshipResolver` contribution — matching
better-auth's Organization plugin's full capability set (see
[00 — better-auth Organization plugin feature inventory](issues/00-better-auth-feature-inventory.md))
but expressed through effect-auth's own primitives (`AuthPlugin.Service`,
`HttpApi` contracts, qadi-delegated authorization). Ready to hand to
`/to-tickets` once resolved.

## Notes

- Domain: `spec/overview.md`, `spec/models/14-organization.md` (non-normative
  sketch, already flags most of this map's open questions),
  `spec/behaviors/18-roles-subject-resolver.md` (BEH-EA-137/138 — the
  exclusive `SubjectResolver` slot Organization must never touch),
  `archive/design/usage-qadi.md` §6.2/§7 (`RelationshipResolver` + policy
  worked example), `ADR-EA-009` (authorization delegated to qadi),
  `ADR-EA-012` (slots are exclusive, registries aggregate).
- Precedent: the `Admin` plugin (impersonation) just completed —
  `.scratch/admin/` — is this map's closest analog for two patterns:
  (1) a plugin needing a core-level `Session`/`Sessions.issue` change
  discovered mid-flight, and (2) a plugin gating its own endpoints via a
  config-supplied predicate over a bare `@qadi/core` `AuthSubject` rather
  than depending on `@effect-auth/qadi` directly (stratum ordering: plugins
  sit below qadi).
- Standing preference: ship the richest/most feature-complete option at
  every fork (confirmed twice, verbatim, during this map's own grilling
  rounds) — full better-auth feature parity is the explicit ask, not a
  narrower subset. See memory `feedback-flexibility-over-complexity`.
- Skills every session should consult: `/grilling`, `/domain-modeling`.

## Decisions so far

- [00 — better-auth Organization plugin feature inventory](issues/00-better-auth-feature-inventory.md) — research: full feature/schema/config inventory of better-auth's real Organization plugin, used to ground every ticket below.
- Destination and initial scope (this map's own charting round, resolved directly — no ticket, recorded here since it shapes every later ticket): full feature parity via effect-auth's own primitives, not a literal port; `Organization` owns per-membership role as plain data (not a `SubjectResolver` override, which stays exclusively `Roles`'); teams and the qadi `RelationshipResolver` wiring are both in scope; an org/team must always retain ≥1 owner, enforced natively (stricter than better-auth's own unenforced baseline); `Organization` is the first real consumer of the existing `HookPoint` mechanism; invitation delivery reuses the existing `Mailer` port (already `Password`'s own pattern).
- [02 — Authorization boundary](issues/02-authorization-boundary.md) — `Organization` ships its own self-contained, statement-based permission engine to gate its own endpoints (no qadi dependency needed, functional out of the box); separately contributes `Organization.relationships` (`RelationshipResolver`) and a new `Organization.attributes` (`AttributeResolver`) as ordinary qadi `Layer`s for application-level policies.
- [03 — Core schema and CRUD](issues/03-core-schema-and-crud.md) — `organization`/`organization_membership` schema, multi-role membership, owner invariant enforced at remove/update-role/leave.
- [04 — Teams](issues/04-teams.md) — `organization_team`/`organization_team_membership`, opt-in, team membership requires prior org membership, distinct `"team-member"` relation.
- [05 — Dynamic access control](issues/05-dynamic-access-control.md) — `organization_role` table, opt-in, no self-escalation beyond the creator's own permissions, checked by the same statement engine (ticket 02) rather than exposed to qadi.
- [06 — Invitations](issues/06-invitations.md) — `organization_invitation` schema and full lifecycle, cascade-deleted when their organization is deleted.
- [07 — Lifecycle hooks](issues/07-lifecycle-hooks.md) — one `HookPoint` veto/observe pair per mutating operation; no core session hook needed.
- [08 — Active organization/team state](issues/08-active-organization-state.md) — `organization_active_context`, plugin-owned, not cascade-deleted on session revocation (documented gap, mirrors `Admin`'s `endedBy: "expired"`).

All decisions above are written up in full in **`.scratch/organization/spec.md`** (produced via `/to-spec`), which is this map's destination — the frontier is now empty.

## Not yet specified

*(none remaining — see Decisions so far)*

## Out of scope

- SSO's own dependency on `Organization` (`archive/design/09-sso.md`, MOD-EA-009: `dependsOn: [Sessions, Users, Organization]`) — a separate future plugin/model that consumes whatever this map produces; not something this map itself needs to resolve.
- A generic, reusable "plugin-contributed authorization predicate" abstraction — `Organization`'s self-contained statement engine and `Admin`'s config-supplied predicate stay two independently-shaped patterns for now (see `spec.md`'s own Out of Scope section).
