# Authorization — Research

Research date: 2026-09-12. All versions/dates verified against primary sources as of this date.

## TL;DR

- **Google Zanzibar (USENIX ATC '19) is the reference design for relationship-based authorization**: relation tuples `object#relation@user` (users may themselves be usersets → nested groups/delegation), namespace configs with *userset rewrite rules* (`_this`, computed_userset, tuple_to_userset composed via union/intersection/expression exclusion), and the **zookie** consistency token that prevents the "new enemy" problem. It serves >2 trillion tuples, >10M QPS, p95 <10ms, >99.999% availability. Full paper read for this research: [USENIX PDF](https://www.usenix.org/system/files/atc19-pang.pdf).
- **The Zanzibar-class engines (SpiceDB, OpenFGA, Ory Keto) are all external services with real operational costs**: data sync into the engine, consistency-token plumbing, latency/uptime on the critical path. Oso's "Why Authorization is Hard" is the best treatment of the embed-vs-delegate tradeoff; its golden rule — *build authorization around your application, not the other way around* — should be effect-auth's default. [Oso essay](https://www.osohq.com/post/why-authorization-is-hard)
- **An auth *library* should own**: principal abstraction, typed permission registry, check/require plumbing, ownership rules, error typing, deny logging. It should **delegate** (via one capability interface): relationship-graph storage, policy DSL parsing, policy distribution, reverse-index list queries — these are what SpiceDB/OpenFGA/Cedar/OPA do.
- **better-auth (verified docs)**: the `admin` plugin owns *global* RBAC (comma-separated `role` strings on the user row; default roles `admin`/`user`; statement registry `{ user: [create, ban, impersonate, …], session: [list, revoke, delete] }`), while the `organization` plugin owns *per-org* RBAC (member rows with `owner`/`admin`/`member`, default resources `organization`/`member`/`invitation`, dynamic roles stored per-org in a table, teams). Effect-auth should mirror this split: **core owns checks, plugins own bindings**. [admin docs](https://better-auth.com/docs/plugins/admin), [organization docs](https://better-auth.com/docs/plugins/organization)
- **Permission-string design is converging on `resource:action` with a compile-time registry**: better-auth's `createAccessControl({ project: ["create","delete"] } as const)` derives TS types; Cedar goes further with typed *Action entities* validated by a schema; OpenFGA/SpiceDB permissions only exist if declared in the model. Effect-auth should adopt a const-typed registry (typo = compile error) with `"resource:action"` runtime encoding.
- **Principal abstraction is solved the same way everywhere except app-level auth libraries**: AWS IAM principals are users/roles/federated identities/applications; Zanzibar subjects are `<type>:<id>` or usersets; SpiceDB recommends *separate subject types per identity source* (and per-provider definitions for multi-provider auth, never emails); Cedar principals are typed entities `User::"alice"`. Effect-auth needs a tagged `Principal` union (user/apiKey/service/anonymous), not a `User` row. [AWS IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/intro-structure.html), [SpiceDB representing users](https://authzed.com/docs/spicedb/modeling/representing-users), [Cedar grammar](https://docs.cedarpolicy.com/policies/syntax-grammar.html)
- **Forbidden vs NotFound is an HTTP-semantics question with an explicit RFC answer**: RFC 9110 §15.5.4 — *"An origin server that wishes to 'hide' the current existence of a forbidden target resource MAY instead respond with a status code of 404"*. Keep both as distinct typed errors; choose the wire mapping per route (default: NotFound for cross-tenant lookups, Forbidden within the tenant). [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4)
- **Oso's open-source library is deprecated** (2024, pivoted to Oso Cloud); Homebrew disabled its CLI cask 2026-09-01. Cautionary tale for embedding a DSL (Polar) in a library: the pivot stranded the embedded-language surface. Effect-auth policies should be *plain TypeScript/Effect functions* (like Ory's TypeScript-flavored OPL), not a new DSL. [oso README](https://github.com/osohq/oso/blob/main/README.md)
- **Cedar is the formal-verification benchmark**: modeled in Lean/Dafny, sound+complete logical encoding, differential testing; its paper compares performance against OpenFGA and Rego "far better". Worth copying its *policy shape* (effect + principal/action/resource scope + when/unless conditions) even though effect-auth policies are code. [Cedar paper](https://arxiv.org/abs/2403.04651), [VGD paper](https://arxiv.org/html/2407.01688v1)
- **Decision observability has prior art to copy**: OPA ships decision logs as a first-class subsystem; Authzed sells audit logging for SpiceDB; the PRD already requires "authorization denial counters". Effect-auth: structured deny events (principal ref + permission + resource ref + reason enum, never payload) + a denial counter, both plugin-contributable. [OPA decision logs](https://openpolicyagent.org/docs/management-decision-logs), [Authzed audit logging](https://authzed.com/docs/authzed/concepts/audit-logging)

## Questions answered

### Q44 — Principal abstraction: unified principal type (user/api-key/service), credential → principal mapping, session-less principals

**Evidence.**

- **AWS IAM** defines the canonical vocabulary: a *principal* is "an IAM user, AWS STS federated user principal, IAM role, or application" that signs in with credentials and is then *authorized*; the request context carries principal + environment data + resource data. Principals are authenticated first, then authorized — the same separation the PRD mandates (§7.5/§7.6). [How IAM works](https://docs.aws.amazon.com/IAM/latest/UserGuide/intro-structure.html)
- **Zanzibar** models every subject as `<namespace>:<object id>` or a *userset* `<object>#<relation>` — i.e., the "user" of a check is a polymorphic reference, which is how groups (`user:u`), delegation (`folder:x#viewer`), and service tokens compose without special cases. [Zanzibar §2.1](https://www.usenix.org/system/files/atc19-pang.pdf)
- **SpiceDB** (authzed's field guide) recommends: users are object types like any resource; use a **stable external ID** (OIDC `sub`) or the local primary key; define a **separate subject type per authentication provider** (`githubuser`, `gitlabuser`) to keep namespaces clean; **never use email addresses** as subject IDs (reuse/verification problems, `@` disallowed); model **anonymous visitors** as their own definition (optionally wildcard `anonymoususer:*`); model **services as their own subject type** or via a token relation (`resource { relation viewer: service#token }`). [Representing Users](https://authzed.com/docs/spicedb/modeling/representing-users)
- **Cedar** bakes the abstraction into the language: every request has a typed `principal` variable constrained by entity types (`principal User::"alice"`), plus `action` and `resource` variables — the validator rejects type-mismatched policies. [Cedar grammar](https://docs.cedarpolicy.com/policies/syntax-grammar.html), [Cedar paper](https://arxiv.org/abs/2403.04651)
- **Ory Keto** checks take a `subject_id` or a `subject_set` (all subjects in relation R of namespace N) — again the two-form subject reference. [Ory relation tuples](https://www.ory.com/docs/keto/concepts/relation-tuples)
- **Casbin** keeps `sub` an opaque string token in the PERM metamodel (`r = sub, obj, act`) — minimal but stringly-typed. [Casbin how it works](https://casbin.org/docs/how-it-works)
- **better-auth** (verified) has *no* principal abstraction: admin/organization permission checks resolve against the authenticated **user** row (`user.role` string(s); membership rows keyed by `userId`); the API-key and session systems authenticate users. Workload identities (machine-to-machine) have no first-class representation — a gap effect-auth can exploit. [admin docs](https://better-auth.com/docs/plugins/admin), [organization docs](https://better-auth.com/docs/plugins/organization)

**Recommendation.**

- Define `Principal` in core as a **Schema-tagged union** sharing a common core:

```ts
const PrincipalRef = Schema.Struct({ type: Schema.String, id: Schema.String }) // Zanzibar-compatible subject: "<type>:<id>"
type Principal =
  | { readonly _tag: "user";         ref: PrincipalRef; userId: UserId }
  | { readonly _tag: "apiKey";       ref: PrincipalRef; keyId: string; scopes: ReadonlyArray<PermissionName>; expiresAt?: number }
  | { readonly _tag: "service";      ref: PrincipalRef; scopes: ReadonlyArray<PermissionName>; issuedVia: "client-credentials" | "token-exchange" }
  | { readonly _tag: "anonymous";    ref: PrincipalRef }
  // every variant may additionally carry: impersonatedBy?: PrincipalRef (audit), authMethodId, authTime
```

- `PrincipalRef { type, id }` is the *only* field downstream systems may rely on — it round-trips exactly to Zanzibar/Ory subject encoding and to SpiceDB definitions, which makes an external ReBAC adapter (Q66) a pure mapping exercise.
- Authentication strategies map credential → `AuthenticatedPrincipal = { principal: Principal; sessionId?: SessionId }`. Session-backed principals (user via cookie/session) carry `sessionId`; **session-less principals** (API key, `client_credentials` service token, anonymous) simply omit it — nothing in the `Authorization` service reads sessions, so session-less principals need no special-casing.
- Per the SpiceDB guidance, derive principal `type` from the *credential source* (e.g. `oauth:google:<sub>` → user principal with provider-prefixed ref) so multi-provider collisions are structurally impossible.
- Reserve `service` principals for machine identities from day one (v1 can issue them via the API-key machinery with `keyKind: "machine"`), because retrofitting a principal union after callers have matched on `User` is the expensive kind of breaking change.

**Confidence:** high (abstraction shape), medium (exact v1 variant set — apiKey-vs-service unification).

### Q64 — Core primitives: Principal + typed permission checks — string permissions vs Schema-checked permission registry

**Evidence.**

- **better-auth** uses a **const-typed string registry**: `createAccessControl({ project: ["create","share","update","delete"] } as const)` → `ac.newRole({ project: ["create"] })`; checks are resource+action pairs (`hasPermission({ permissions: { project: ["create"] } })`). The `as const` gives compile-time checking; there is no runtime schema — the wire format is `Record<string, string[]>`. [admin access control](https://better-auth.com/docs/plugins/admin#access-control)
- **Casbin** is fully string-based: PERM metamodel (Request, Policy, Effect, Matcher) with `r.sub/r.obj/r.act` strings and regex matchers — maximal flexibility, zero type safety, typos fail silently. [Casbin how it works](https://casbin.org/docs/how-it-works)
- **Cedar** makes actions **typed entities**: `action` can be an entity or member of an *action group* (`action in [read, write]`), and the Cedar **validator** uses the entity schema to prove that policies only reference existing principal/action/resource types — the strongest form of the "registry" idea, backed by formal verification. [Cedar grammar](https://docs.cedarpolicy.com/policies/syntax-grammar.html), [Cedar paper](https://arxiv.org/abs/2403.04651)
- **OpenFGA / SpiceDB / Keto**: a permission exists only if declared in the model (`permission delete = owner or admin` / `permission` blocks in OPL); checking an undeclared permission is an API error. The model *is* the registry. [OpenFGA intro](https://openfga.dev/docs/), [Ory Permission Language](https://www.ory.com/docs/keto/reference/ory-permission-language)
- The PRD already sketches `Authorization.requirePermission("project:delete")` and lists permission-based access control, RBAC, ownership, org membership, ABAC as candidate models (PRD §16).

**Recommendation.**

- v1 primitive: a **plugin-contributable, const-typed permission registry** with a `"resource:action"` runtime encoding:

```ts
// plugin or app code
export const perms = makePermissions({ project: ["create", "update", "delete"] } as const)
// typeof perms.action.project.delete = "project:delete" (branded PermissionName)
const Authz = yield* Authorization
yield* Authz.require(perms.action.project.delete) // "project:delete"
yield* Authz.require("project:delete" as PermissionName) // also fine at boundaries after Schema validation
```

- Registry rules: names are namespaced by contributing plugin (compiler enforces uniqueness — same mechanism as capability namespaces, PRD §34); a `PermissionName` is a **branded Schema.String** with a codec validating `^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$` at every boundary (HTTP body, config, DB column), so stored role bindings can be validated on read.
- Permissions carry optional metadata at registration (`{ description, since }`) for docs/UI; keep the runtime object tiny and serializable so role tables store plain strings (better-auth's approach) and remain portable to external engines.
- Checks live on the `Authorization` service (one core tag): `check(): Effect<boolean, AuthzError>`, `require(): Effect<void, Forbidden | ResourceNotFound>`, `filter()` stub (Q67/Q70). `requirePermission("project:delete")` stays as the PRD-shaped alias.
- Do **not** build a policy DSL. Type the registry in TypeScript; if richer policy text is ever needed, adopt/borrow Cedar rather than inventing syntax (Oso's DSL-turned-deprecated-library is the cautionary tale).

**Confidence:** high.

### Q65 — RBAC: roles/permissions bindings in core or plugin? `admin` plugin vs `organization` plugin

**Evidence (better-auth, verified).**

- **admin plugin (global RBAC)**: adds `role` (+ `banned`, `banReason`, `banExpires`) columns to the **user** table; multiple roles stored as a comma-separated string; default roles `admin` (full control over users/sessions) and `user` (none); `adminRoles` and `adminUserIds` options; default statements `user: [create, list, set-role, ban, impersonate, impersonate-admins, delete, set-password, set-email, get, update]` and `session: [list, revoke, delete]`; roles are merged with user-defined access-control roles via `defaultStatements`; permission checks exposed as `POST /admin/has-permission` and sync `checkRolePermission` on the client. [admin docs](https://better-auth.com/docs/plugins/admin)
- **organization plugin (scoped RBAC)**: separate `member` rows per organization with roles; default org roles `owner`/`admin`/`member` with the canonical split (owner: everything; admin: everything except delete-org/change-owner; member: read-only); default statements on resources `organization: [update, delete]`, `member: [create, update, delete]`, `invitation: [create, cancel]`; **dynamic access control**: per-org custom roles persisted in a table (`createRole` gated by `ac` permissions; `maximumRolesPerOrganization` limits); **teams** gated by `team: [create, update, delete]`; invitations carry roles and (optionally) require email verification. [organization docs](https://better-auth.com/docs/plugins/organization)
- **Authorization Academy Ch. III** frames RBAC as *four evolving models* (role-per-user → roles with permission bindings → resource-scoped roles → multi-tenant roles), i.e., "start simple, grow" is the industry-expected trajectory. [Academy](https://www.osohq.com/academy/what-is-rbac)

**Recommendation.**

- **Core owns check plumbing, never bindings**: `Authorization` service, permission registry, policy combinators, error types, deny logging. No `role` column, no `role` table in core — proven by the better-auth dependency audit: both RBAC flavors are purely additive plugins.
- **`@effect-auth/plugin-roles` ("admin-style") owns global RBAC**: `user.role` column (array-validated via side-table `user_role(user_id, role)` rather than comma-encoding), `role → PermissionName[]` bindings (statically defined in code by default, optionally DB-backed), user-management endpoints behind `user:*` / `session:*` permissions, impersonation opt-in. This is also where a "first admin bootstrap" story lands (ties to the seeds/import work in the persistence research).
- **`@effect-auth/plugin-organization` (phase 2) owns scoped RBAC**: membership rows + org-scoped role bindings + invitations + teams (outline in Q68). It *requires* the registry capability and the roles plugin if cross-product (global ∩ org) checks are wanted.
- Contract-test guarantee: an app that installs neither plugin gets a working `Authorization` service where every non-anonymous check fails closed — proving the core/plugin boundary (PRD §5.1 capability-over-implementation).

**Confidence:** high.

### Q66 — ReBAC future-proofing: Zanzibar-style model / external SpiceDB & OpenFGA adapters via capabilities

**Evidence — the Zanzibar model (paper read in full for this research).**

- **Data model**: ACLs are *relation tuples* `object#relation@user` with `object = namespace:id` and `user = user_id | userset(object#relation)`. Groups are just ACLs with `member` semantics; tuples may reference other tuples, giving nested membership for free. [Zanzibar §2.1](https://www.usenix.org/system/files/atc19-pang.pdf)
- **Configuration**: per-namespace *userset rewrite rules* composed of `_this`, `computed_userset` (concentric relations: viewer ⊇ editor ⊇ owner), `tuple_to_userset` ("viewers of my parent folder"), combined via union/intersection/exclusion — this is the whole RBAC/ReBAC expressiveness in ~3 primitives. [§2.3.1](https://www.usenix.org/system/files/atc19-pang.pdf)
- **APIs**: Check, Read, Write, Watch, Expand (+ content-change Check returning the **zookie**). Zookies = opaque timestamps giving external consistency + bounded-staleness snapshot reads; they are what prevents the **"new enemy" problem** (revoked user still seeing newer content). [§2.2/§2.4](https://www.usenix.org/system/files/atc19-pang.pdf)
- **Scale/engineering**: Spanner-backed, Leopard denormalized index for deep/wide nesting, cache trees + lock tables for hot spots, request hedging; 2T+ tuples, ~100TB, >10M QPS, p95 <10ms, 99.999% availability; median namespace config ~500 lines. [§3–§4](https://www.usenix.org/system/files/atc19-pang.pdf)

**Evidence — the open-source field (verified 2026-09).**

- **SpiceDB** (authzed, Apache-2.0, ~7k stars per docs): Go Zanzibar implementation; schema language (`definition`/`relation`/`permission`), **caveated** and **expiring** relationships, consistency levels per request (`minimize_latency`, `at_least_as_fresh`, `at_exact_snapshot`, `fully_consistent`) keyed by **ZedTokens**; docs explicitly recommend storing ZedTokens alongside protected content (varchar(1024) column) to get read-after-write without full-consistency cost. [Consistency docs](https://authzed.com/docs/spicedb/concepts/consistency)
- **OpenFGA** (CNCF, Zanzibar-inspired): stores/model/tuples; `check`, `list_objects`, conditions (ABAC-lite via conditional tuples + contextual tuples), runs embedded as a Go library or as a service on Postgres/MySQL/SQLite; JS SDK first-class. [OpenFGA docs](https://openfga.dev/docs/)
- **Ory Keto / Ory Permissions**: Zanzibar-derived; the **Ory Permission Language is TypeScript-shaped** (`class File implements Namespace { related: { viewers: (User | SubjectSet<Group,"members">)[] }; permits = { view: (ctx) => this.related.viewers.includes(ctx.subject) || … } }`) — proof that a Zanzibar-model config language can literally be TS. [OPL reference](https://www.ory.com/docs/keto/reference/ory-permission-language)
- **Embed vs delegate**: Oso's six-architecture matrix — the decision *data* is mostly application data; centralizing it means syncing "most of the data in your application", plus latency/uptime SLAs on the hot path, plus enforcement still living in the app. Zanzibar-style "reverse indexing" (list all resources a user can see) requires that same centralized data. [Why Authorization is Hard](https://www.osohq.com/post/why-authorization-is-hard)

**Recommendation — the seam.**

- Core defines **one capability**, the `Authorizer` (all methods take/return Schemas; deny by default):

```ts
class Authorizer extends Context.Service<Authorizer>()(
  "effect-auth/Authorizer",
  Effect.gen(function* () {
    return {
      // does `p` hold `perm` on `r`? boolean result, typed error channel for engine failures
      check: (p: PrincipalRef, perm: PermissionName, r: ResourceRef,
              consistency?: ConsistencyToken) => Effect<boolean, AuthzError>,
      // like check, but fails with Forbidden | ResourceNotFound and logs the denial
      require: (p: PrincipalRef, perm: PermissionName, r: ResourceRef) =>
        Effect<void, Forbidden | ResourceNotFound>,
      // reverse query: which resources of `kind` can `p` access? (list filtering).
      // External adapters implement via list-objects; the local impl covers only
      // ownership + roles pushdown, else fails with UnsupportedOperation.
      filter: (p: PrincipalRef, perm: PermissionName, kind: ResourceKind) =>
        Effect<Stream<ResourceId>, AuthzError | UnsupportedOperation>,
      subjectOf: (principal: Principal) => PrincipalRef,
    }
  })
) {}
```

- **Default layer**: `AuthorizerLocal` — resolves checks against the in-app registry + roles plugin + ownership rules (Q65/Q67). Zero external deps, TestClock-testable.
- **External plugins** (`@effect-auth/plugin-openfga`, `plugin-spicedb`) replace the same service via `Layer.provide`; they translate `PrincipalRef`/`ResourceRef` to subject tuples, run `check`, and surface engine consistency:
  - `ConsistencyToken` = opaque `Schema.String` (zookie/ZedToken); resource tables get an optional `authzToken` column pattern (SpiceDB's documented workflow) so a route can demand read-after-write without hardcoding engine details.
  - Relationship *management* endpoints (who can edit doc X / write tuples) stay behind the same service — apps do not import vendor SDKs directly.
- Contract: `filter` is the only method an external adapter may implement asynchronously-and-expensively, and the only one allowed to be a stub (local impl: ownership + roles pushdown only). This keeps v1 honest about the list-filtering cliff Oso describes.
- Future ReBAC-in-core stays possible because checks already speak `(PrincipalRef, PermissionName, ResourceRef)` — the Zanzibar tuple shape — so a first-party relationship store would be another `Authorizer` layer, not a breaking change.

**Confidence:** high (seam), medium (exact `filter`/token ergonomics).

### Q67 — Ownership checks: `requireOwned(resource)` vs policy objects, typed against resource schemas

**Evidence.**

- **Oso Academy Ch. V (ReBAC)**: the base patterns are data ownership (`post.ownerId == user.id`), parent-child inheritance, and groups; "ownership" is just the degenerate case of a relationship — recommending modeling it like one, not as special-case code. [Academy ReBAC](https://www.osohq.com/academy/relationship-based-access-control-rebac)
- **Oso essay**: the pundit `authorize @post` pattern (policy objects keyed by resource) is the most common resource-level enforcement; but "re-implementing `Post.find(params[:id])` inside middleware" is the classic over-reach — resource objects must be loaded by the app, then checked. [Why Authorization is Hard](https://www.osohq.com/post/why-authorization-is-hard)
- **CASL** encodes ownership as attribute conditions on permission strings (`can('read', 'Post', { authorId: 1 })`) — simple, but the essay notes it couples policy to schema fields (`authorId` becomes load-bearing). [Oso essay §I](https://www.osohq.com/post/why-authorization-is-hard)
- **Cerbos** computes ownership dynamically as a *derived role* (`derivedRoles: owner` from `request.resource.attr.owner == request.principal.id`) then grants rules to the derived role — decoupling "who is an owner" from every rule that needs it. [Cerbos resource policies](https://docs.cerbos.dev/cerbos/latest/policies/resource_policies.html)
- **Cedar** expresses ownership inline as conditions (`permit(principal, action, resource) when { resource.owner == principal }`) validated against the entity schema. [Cedar grammar](https://docs.cedarpolicy.com/policies/syntax-grammar.html)

**Recommendation.**

- Make **check functions the primitive** and `requireOwned` sugar:

```ts
// core
interface OwnershipRule<R> {
  readonly resource: Schema.Schema<R>            // typed against the resource Schema
  readonly holds: (principal: PrincipalRef, resource: R) => Effect<boolean, AuthzError>
}
// registry: plugins/app contribute rules; default convention rule:
ownerIdRule(Schema.Struct({ ownerId: UserIdSchema }))  // => "owner" pseudo-role
```

- `Authz.require(perm, resource)` runs: explicit grants (roles) ∪ ownership rules ∪ (later) org membership — evaluated deny-by-default, short-circuiting allows.
- Typing: because rules carry the resource `Schema`, `require(projectPerms.delete, someRow)` is checked at compile time against the declared resource type, and the *same* Schema doubles for HTTP input validation (one source of truth, PRD §5.4).
- Naming: expose `requireOwned(resource)` as a documented convenience for the single-owner convention (`resource.ownerId == principal`), but the registry/composition machinery (Q69) is what plugins extend — this avoids better-auth-style "owner is a magic role string" while keeping the 80% case one call.
- Ownership data conventions: single `ownerId` column, documented; multi-owner or inherited ownership (folders) is the ReBAC escape hatch (Q66), not more columns.

**Confidence:** high.

### Q68 — Organization/team (phase 2): membership, per-org roles, invitations, sub-orgs — schema and API outline

**Evidence — better-auth inventory (verified, the direct comparable).**

- Tables: `organization` (name, slug, logo, metadata), `member` (organizationId, userId, role, createdAt), `invitation` (email, role, organizationId, status, teamId?, inviterId), `team` + `teamMember` (optional), dynamic-role table per org (with `maximumRolesPerOrganization` quotas, plan-dependent). Sessions carry `activeOrganizationId` (created with `keepCurrentActiveOrganization` toggle). [organization docs](https://better-auth.com/docs/plugins/organization)
- Options verified: `allowUserToCreateOrganization` gate, `creatorRole` (`admin | owner`), `membershipLimit` (default 100, plan-aware fn), `organizationDeletion` hooks, `requireEmailVerificationOnInvitation` (recommended when invitation IDs can be enumerated), org-creation/deletion/member-role hooks. Same source.
- **Sub-orgs / hierarchy**: not present in better-auth's docs — orgs are flat; hierarchy is the ReBAC systems' home turf (OpenFGA ships multi-tenant SaaS modeling patterns; OPL example literally models folder hierarchies). [OpenFGA use cases](https://openfga.dev/docs/use-cases), [OPL example](https://www.ory.com/docs/keto/reference/ory-permission-language)
- SpiceDB's "Representing Users" and Access Control Management docs describe the standard audit/management surface (who has access to X / what can Y access) an org plugin should expose. [Representing Users](https://authzed.com/docs/spicedb/modeling/representing-users)

**Recommendation — outline (phase 2, but schema-shaped now).**

- Schema (plugin-contributed via the schema IR):
  - `organization(id, name, slug unique, logo?, metadata jsonb, created_at)`
  - `organization_member(id, organization_id → organization, user_id → user, roles text[] , created_at)`; unique `(organization_id, user_id)`
  - `organization_invitation(id, organization_id, email, roles text[], status enum(pending/accepted/rejected/canceled/revoked), token_hash, inviter_id, expires_at, created_at)` — single-use hashed token (same hashed-token pattern as purpose-scoped verification tokens)
  - `organization_role(id, organization_id, name, permissions jsonb)` — dynamic roles, capped (`maximumRolesPerOrganization` analog), only grantable ⊆ granter's permissions (better-auth's non-escalation rule)
  - optional `team(id, organization_id, name)` + `team_member(team_id, member_id)`
- API (HttpApi, plugin-prefixed `POST /organizations/*`): create/update/delete, `checkSlug`, member list/add/update-role/remove, invite/accept/reject/cancel/resend, `setActive` (writes `activeOrganizationId` into the session — needs a small session-extension seam from core), role CRUD, team CRUD. All mutating routes behind org-scoped permissions (`organization:invite`, `member:update`, …) registered by the plugin (Q64 registry).
- Authorization integration: membership resolves org roles into an *org-scoped* subject (`organization:<id>#<role>` shaped refs) so the same `Authorizer` checks work, and a future SpiceDB mirror is mechanical.
- **Sub-orgs**: do not model in v2 tables; document the external-ReBAC path (parent relation tuples) — better-auth's flatness is a real limitation and we shouldn't rebuild hierarchies badly in SQL before customers ask.
- Sessions/membership guardrails to copy: verified-email gating on invitations (better-auth's 2025 hardening), membership limits, creator-role choice, delete-org → cascade with hooks.

**Confidence:** high (inventory/design), decision on timing → Open questions.

### Q69 — Policy composition: AND/OR/not, ABAC predicates as Effects, Forbidden vs NotFound

**Evidence.**

- **Cedar**: policies are `permit|forbid (principal, action, resource) when|unless { expr }`; exprs are typed boolean/attribute logic (`&&`, `||`, `!`, `has`, `like`, `if/then/else`); `permit`-`forbid` combination is evaluate-all-then-resolve (forbid wins). [Cedar grammar](https://docs.cedarpolicy.com/policies/syntax-grammar.html)
- **Cerbos**: rule effect resolution is documented — deny beats allow per role+action; any role's allow wins overall (so least-privileged roles can't lock out admins); conditions are CEL-style expressions over request/resource attributes; scoped policies layer tenant → hierarchy with explicit parental-consent semantics for allows. [Cerbos resource policies](https://docs.cerbos.dev/cerbos/latest/policies/resource_policies.html)
- **AWS IAM** evaluation order: default deny → explicit allow overrides → permission-boundary/SCP must also allow → **explicit deny always wins**. [How IAM works](https://docs.aws.amazon.com/IAM/latest/UserGuide/intro-structure.html)
- **OPA/Rego**: decisions are arbitrary data over `input`; `every`/`some` for quantification — the general-purpose end of the spectrum, with the documented learning-curve cost. [OPA docs](https://openpolicyagent.org/docs)
- **ABAC-as-Effect**: unlike Cedar/Cerbos (attributes arrive in the request), an in-process library can *fetch* attributes — which is exactly Oso's "decision data = application data + facts" point; predicates that hit the DB must be Effects. [Why Authorization is Hard](https://www.osohq.com/post/why-authorization-is-hard)
- **Forbidden vs NotFound**: RFC 9110 §15.5.4 — 403 means "server understood the request but refuses to fulfill it", and *"An origin server that wishes to 'hide' the current existence of a forbidden target resource MAY instead respond with a status code of 404"*. §15.5.5 — 404 explicitly covers "is not willing to disclose that one exists". [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4)

**Recommendation.**

- Policy type: `type Policy = (ctx: PolicyContext) => Effect<boolean, AuthzError>` — plain functions, composed with core combinators:

```ts
const canManageProject = AuthzPolicy.all(
  AuthzPolicy.hasRole("admin"),              // RBAC predicate
  AuthzPolicy.memberOf(project.orgId),       // org-scoped predicate (Q68)
  AuthzPolicy.any(
    AuthzPolicy.owns(projectSchema),         // ownership rule (Q67)
    AuthzPolicy.resourceIsPublic,            // attribute of the loaded resource
  ),
  AuthzPolicy.not(AuthzPolicy.suspended),
)
// ABAC predicate as an Effect — it may query the repository:
AuthzPolicy.when((ctx) => repo.isUnderMaintenance(ctx.resource))
```

- Evaluation semantics (decide once, document forever): **deny-by-default**; `all` short-circuits on first false; `any` short-circuits on first true; **explicit `forbid` policies override allows** (Cedar/IAM ordering); predicates run in parallel where pure (Effect `all` with `discard`), sequential when they touch the repository.
- Error typing: `Forbidden` and `ResourceNotFound` are **distinct typed errors in the same `AuthzError` union**; `require` reports which internally, and the *HTTP mapping is a route-level concern*: default `ResourceNotFound → 404`, `Forbidden → 403`, with a per-route `notFoundOnDeny: true` escape hatch for cross-tenant resources (enumeration safety — coordinate with the framework-wide enumeration-resistance work). Error payloads never include resource ids beyond what the caller opts into.
- Keep policies pure TypeScript — composable, refactorable, testable with `TestClock`; a DSL adds a parser + error messages + tooling for zero new runtime capability (see Oso's deprecated DSL library).

**Confidence:** high.

### Q70 — Enforcement ergonomics: middleware `requirePermission` vs in-handler service calls; enforce one style?

**Evidence.**

- **Oso (the definitive treatment)**: enforcement has no single right place — resource-level checks (pundit `authorize @post`) are explicit and flexible but scattered; middleware-level checks become coarse or re-implement data loading ("we've now pushed application logic into the authorization code"); list/data filtering and UI permission surfaces need their own seams. Conclusion: *enforcement must be a first-class citizen*, with `authorize` / `authorized_actions` / `authorized_resources` as the trio. [Why Authorization is Hard](https://www.osohq.com/post/why-authorization-is-hard), [Academy Ch. VI](https://www.osohq.com/academy/authorization-enforcement)
- **better-auth** enforcement is in-handler/API-level: every admin/organization endpoint internally calls its permission check (`hasPermission` etc.); there is no route-middleware permission layer. [admin docs](https://better-auth.com/docs/plugins/admin)
- **Effect HttpApi** provides typed middleware (`HttpApiMiddleware` in `@effect/platform`) that can inject services/context per group or route — the natural home for *coarse* gates (authenticated-only, permission-without-resource), while resource-scoped checks necessarily happen after the resource is loaded. [HttpApiMiddleware in platform](https://github.com/Effect-TS/effect/issues/6121)

**Recommendation.**

- **Primary style: in-handler `Authz.require(permission, resource?)`** — it's the only style that has the loaded resource in scope; middleware cannot know `project:delete` means "the project with this id". This matches the PRD's `Authorization` service sketch (§16).
- **Secondary style: HttpApi middleware for coarse gates** — `HttpApiMiddleware` layer requiring authentication and optionally a *resource-less* permission (`admin:access`); it contributes `CurrentPrincipal` (Q34's question, owned by the HTTP research) so handlers get principals typed.
- Making the style **checkable, not forcibly one**: ship in `@effect-auth/test` a contract test that (a) walks the compiled route table and asserts every route carrying an `id`-shaped path param either declares an authorization middleware or its handler reference includes an `Authz.require` call (cheap static pass over the compiled route definitions), and (b) at runtime, wraps handlers in a dev-mode FiberRef counter that warns when a route loaded a resource by id but performed zero authorization checks. An ESLint rule can come later; the contract-test harness is plugin-shaped (PRD Q31) and needs no new tooling.
- Provide the enforcement trio from day one (Oso's proven surface): `require` (void, throws typed errors), `check` (boolean), `authorizedActions(principal, resource): Effect<PermissionName[]>` — the last powers permission-aware UIs (the Slack/GitHub pattern Oso documents) via one `GET /me/permissions` endpoint from the roles plugin.

**Confidence:** medium-high (contract-test mechanics), high (two-style verdict).

### Q71 — Decision observability: deny logs with principal+permission (never payload), metrics on denials

**Evidence.**

- **OPA** ships **Decision Logs** as a first-class subsystem: every policy decision can be reported to remote HTTP endpoints, custom plugins, or console — "comprehensive audit trails for every policy decision" is the product headline. [OPA decision logs](https://openpolicyagent.org/docs/management-decision-logs)
- **Authzed** sells **Audit Logging** for managed SpiceDB — evidence that authorization decisions/access changes are audit-grade events customers pay for. [Audit logging docs](https://authzed.com/docs/authzed/concepts/audit-logging)
- **PRD already requires it**: observability section lists "authorization denial counters" among core metrics and typed `Forbidden` among core errors; redaction rules exist (PRD §15/§16 area). Cross-check: redaction defaults are a framework-wide concern; effect-auth events are Schemas (PRD §18).
- **Cerbos** audit story: policy rule outputs can emit structured strings on activation (`output.when.ruleActivated`) — per-decision explainability hooks. [Cerbos resource policies](https://docs.cerbos.dev/cerbos/latest/policies/resource_policies.html)

**Recommendation.**

- One structured event, emitted by the `Authorization` service itself (not by each plugin) on **every deny** and (opt-in) every allow:

```ts
AuthzDenied = {
  principal: { type: string, id: string },   // PrincipalRef, not User row, not email
  permission: PermissionName,                // "project:delete"
  resource:  { type: string, id: string },   // ResourceRef; id redactable per config
  decision:  "denied" | "allowed",
  reason:    "no-role" | "not-owner" | "not-member" | "policy" | "engine-error",
  via:       "local" | "external",           // which Authorizer layer decided
}
```

- Hard rules: **never** log request/resource payloads, emails, or session tokens in authz events (align with the framework-wide redaction capability); resource ids are pseudonymous references only.
- Metrics: counter `effect_auth_authz_checks_total{permission,result,via}` and `effect_auth_authz_denials_total{permission,reason}` (PRD's "authorization denial counters"); a span `authz.check` per check with low-cardinality attributes only (permission, result) — never the resource id (cardinality + redaction).
- Plumb events through the plugin event bus (PRD §18) so an audit plugin can persist, and a SIEM integration can subscribe — the decision *emitter* stays core, the *sink* is a plugin.
- Expose a `explainLast()`/`why` dev-mode affordance (the "why" UX Oso highlights via Nunemaker's deny-with-reason pattern) so apps can return human guidance like "Disabled tokens cannot access the API" without leaking policy internals. [Oso essay](https://www.osohq.com/post/why-authorization-is-hard)

**Confidence:** high.

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to effect-auth |
|---|---|---|---|---|
| Google Zanzibar | Internal Google global ACL system; relation tuples + userset rewrites + zookies; the ReBAC reference paper | n/a (paper) | Production at Google since ~2014 (paper 2019) | The conceptual target for Q66's seam; its tuple shape is our `PrincipalRef`/`ResourceRef` encoding |
| SpiceDB (authzed) | Open-source Zanzibar implementation (Go); schema language, caveats, expiring relations, ZedTokens; Authzed Cloud/Managed SpiceDB | Apache-2.0 | Mature, ~7k stars, commercial company behind it | Primary external-ReBAC adapter target; consistency-token workflow documented for app DBs |
| OpenFGA | CNCF Zanzibar-inspired engine (Okta origin); stores/models/tuples/conditions, `list_objects`, JS SDK, Postgres/MySQL/SQLite, embeddable as Go lib | Apache-2.0 | CNCF project, active | Most pragmatic external adapter (SQL-backed, JS SDK); conditions show Zanzibar+ABAC hybrid |
| Ory Keto / Ory Permissions | Zanzibar-based permission server; **Ory Permission Language is TypeScript-shaped** (classes, `SubjectSet`, `permits` functions) | Apache-2.0 | Mature (Ory Network productized it) | OPL proves a TS-native policy/model definition surface; direct design input for our registry ergonomics |
| AWS Cedar | Policy language + Rust engine: typed entities, permit/forbid + when/unless, validator, formally verified (Lean/Dafny) | Apache-2.0 | Production in AWS (Verified Permissions), open source | Benchmark for policy shape + validation rigor; its `permit(principal, action, resource)` is the check signature to mirror |
| OPA / Rego | General-purpose policy engine (CNCF graduated); Datalog-family Rego over JSON; decision logs; WASM bundling | Apache-2.0 | CNCF graduated, ubiquitous in infra policy | Delegation target for non-domain policies; cautionary example of DSL learning curve for app authz |
| Oso (library) | Embedded policy library (Polar DSL) for many languages — **deprecated** upstream; Oso Cloud is the active SaaS (Ruby/Go/TS/JS/Rust clients) | Library deprecated; SaaS proprietary | Oso Cloud GA; OSS lib sunset (README deprecation; brew cask disabled 2026-09-01) | Design lessons: enforcement trio (`authorize`/`authorized_actions`/`authorized_resources`), the three-hard-problems framing, DSL risk |
| Casbin (Apache Casbin, incubating) | PERM metamodel (Request/Policy/Effect/Matcher) with .conf model files; RBAC/ABAC/ReBAC model gallery; 100+ language ports | Apache-2.0 | Very widely used; now Apache Incubating | The string-matcher baseline to beat on type safety; its model-file idea = our registry declarations |
| Permit.io | AuthZ-as-a-service: API + no-code editor + local PDP; **OPAL** (open-source policy/data distribution layer for OPA/Cedar agents); multi-engine PDP | OSS (OPAL, PDP) Apache-2.0 + SaaS | Active commercial | Reference for the policy-distribution plane effect-auth should *not* build; also RBAC→ABAC→ReBAC packaging |
| Cerbos | Stateless PDP: YAML/JSON resource policies with derived roles, conditions, scoped policies (hierarchies), principal/resource schemas; Cerbos Hub SaaS | Cerbos CE Apache-2.0; Hub SaaS | Active commercial | Best-in-class docs for effect-resolution rules and derived roles; scoped policies = tenant-hierarchy prior art |

## Books, papers, blogs, talks

- **Zanzibar: Google's Consistent, Global Authorization System** (Pang et al., USENIX ATC '19) — [PDF](https://www.usenix.org/system/files/atc19-pang.pdf) · the ReBAC design source of truth; read in full for this research (model summary in Q66).
- **Cedar: A New Language for Expressive, Fast, Safe, and Analyzable Authorization** (Cutler et al., 2024) — [arXiv:2403.04651](https://arxiv.org/abs/2403.04651) · typed entities, validator, Lean-modeled semantics; includes OpenFGA/Rego performance comparison.
- **How We Built Cedar: A Verification-Guided Approach** (2024) — [arXiv:2407.01688](https://arxiv.org/html/2407.01688v1) / [ACM](https://dl.acm.org/doi/10.1145/3663529.3663854) · the process paper (Dafny/Lean models, differential testing); also [Amazon Science explainer](https://www.amazon.science/blog/how-we-built-cedar-with-automated-reasoning-and-differential-testing) and [Lean use-case page](https://lean-lang.org/use-cases/cedar/).
- **Authorization Academy** (Oso; Sam Scott et al., 8 chapters incl. RBAC, ABAC, ReBAC, Enforcement, Microservices, LLM apps) — [index](https://www.osohq.com/academy) · the industry-standard *architecture* text; Ch. VI (Enforcement) and Ch. V (ReBAC + "Golden Rule") directly shaped Q67/Q70. Note: often misattributed to authzed — it is Oso's series.
- **Why Authorization is Hard** (Sam Scott, Oso) — [essay](https://www.osohq.com/post/why-authorization-is-hard) · enforcement/decision-architecture/modeling triangle; the six decision architectures; embed-vs-delegate tradeoff matrix.
- **What is Google Zanzibar** (Jake Moshenko, authzed) — [blog](https://authzed.com/blog/what-is-google-zanzibar) + **Annotated Zanzibar** — [authzed.com/zanzibar](https://authzed.com/zanzibar) · practitioner walkthroughs keyed to the paper.
- **SpiceDB consistency & ZedTokens docs** — [authzed docs](https://authzed.com/docs/spicedb/concepts/consistency) · how to plumb consistency tokens into an app DB without full-consistency cost.
- **Ory Permission Language reference** — [ory.com docs](https://www.ory.com/docs/keto/reference/ory-permission-language) · a Zanzibar model language that is *literally TypeScript-shaped* — closest prior art to an Effect-native model DSL.
- **RFC 9110 §15.5.4–15.5.5** — [rfc-editor](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4) · the canonical 403-hides-as-404 semantics for enumeration safety.
- **Casbin PERM paper** (Hu et al., 2019) — [arXiv:1903.09756](https://arxiv.org/pdf/1903.09756) · the metamodel abstraction (Request/Policy/Effect/Matcher) behind Casbin's model files.
- **Practitioner engineering posts** (linked from the Oso essay, useful for PRD evidence): Airbnb Himeji, Carta AuthZ, Slack role management, Intuit AuthZ — centralized-authz war stories, all reaching for Zanzibar-like systems at scale.
- **USENIX ATC '19 talk video** (Zanzibar) — [YouTube](https://www.youtube.com/watch?v=mstZT431AeQ) · 20-minute summary for team onboarding.

## People & projects to follow

- **Jake Moshenko** — co-founder/CEO of AuthZed (SpiceDB); Zanzibar explainers and consistency writing — [AuthZed](https://authzed.com/why-authzed), [What is Google Zanzibar](https://authzed.com/blog/what-is-google-zanzibar)
- **Sam Scott** — co-founder/CTO of Oso; author of Authorization Academy and "Why Authorization is Hard" — [Oso](https://www.osohq.com/), [Academy](https://www.osohq.com/academy)
- **Aeneas Rekkas** — Ory co-founder/CTO; Keto/OPL design — [Ory](https://www.ory.com/), [OPL](https://www.ory.com/docs/keto/reference/ory-permission-language)
- **Torin Sandall** — OPA co-creator (Styra VP of open source); Rego/policy-engine evolution — [OPA](https://openpolicyagent.org/), [KCCNC bio](https://kccncchina2018chinese.sched.com/event/FvKJ/tao-daepopen-policy-agenttorin-sandalldaelsstyra)
- **Cedar team** — Joseph W. Cutler, Emina Torlak, Michael Hicks, Kesha Hietala et al. (AWS + UW); formal-methods approach to authz — [Cedar](https://cedarpolicy.com/), [paper authors](https://arxiv.org/abs/2403.04651)
- **Yang Luo** — Casbin creator (Peking University; also Npcap author); PERM metamodel and multi-language ecosystem — [Casbin authors](https://casbin.org/blog/authors/), [GitHub](https://github.com/hsluoyz)
- **Ruoming Pang** — Zanzibar lead author (Google) — [USENIX page](https://www.usenix.org/conference/atc19/presentation/pang)

## Recommended defaults for effect-auth

1. **`Principal` is a Schema-tagged union in core** (`user | apiKey | service | anonymous`) sharing `PrincipalRef {type, id}` (Zanzibar-subject-compatible); every authorization check takes `PrincipalRef`, never `User`. Strategies produce `AuthenticatedPrincipal`; session-less principals simply have no `sessionId` (Q44).
2. **Typed permission registry, `"resource:action"` encoding**: `makePermissions({ project: ["create","delete"] } as const)` → branded `PermissionName` union; plugin-namespaced; `PermissionName` codec (`^[a-z]+[a-z0-9_]*:[a-z][a-z0-9_]*$`) validates at every boundary; role tables store plain strings (portable to external engines) (Q64).
3. **One core `Authorization`/`Authorizer` service** with `check`, `require`, `filter`, `authorizedActions`, `subjectOf` — deny-by-default, all decisions logged. `requirePermission("x:y")` alias kept for PRD continuity (Q64/Q70).
4. **Plain-Effect policy composition**: `Policy = (ctx) => Effect<boolean, AuthzError>`; combinators `all/any/not/when`; explicit `forbid` overrides allows (Cedar/IAM ordering); no DSL — TypeScript is the policy language (Q69).
5. **Ownership as contributed rules typed against resource Schemas** (`OwnershipRule<R>` + `ownerIdRule` convention), with `requireOwned(resource)` as documented sugar; multi-owner/hierarchy goes the ReBAC route, not more columns (Q67).
6. **Core/plugins split for RBAC**: core ships zero bindings; `plugin-roles` owns global RBAC (user roles, static or DB-backed bindings, admin/user management permissions, impersonation opt-in); `plugin-organization` (phase 2) owns membership, per-org roles + dynamic roles, invitations (hashed single-use tokens, verified-email gating), teams, active-org session field; flat orgs — no sub-org tables (Q65/Q68).
7. **The external-engine seam is one capability**: `Authorizer` Layer swap (`plugin-openfga`, `plugin-spicedb`) with opaque `ConsistencyToken` support and the optional `authzToken` column workflow for read-after-write; apps never import vendor SDKs; `filter` is the only method allowed to be a partial stub locally (Q66).
8. **Enumeration-safe error mapping**: `Forbidden` and `ResourceNotFound` typed errors; default mapping Forbidden→403, cross-tenant deny→404 (`notFoundOnDeny` per route), per RFC 9110 §15.5.4; reason enum (`no-role|not-owner|not-member|policy|engine-error`) internally, not in responses (Q69).
9. **Enforcement style is in-handler-first** (`Authz.require(perm, resource)` after loading), HttpApi middleware for coarse/resource-less gates, and a `@effect-auth/test` contract test that fails routes which load-by-id without a check; ship `authorizedActions` + a `GET /me/permissions` endpoint for permission-aware UIs (Q70).
10. **Decision observability in core**: structured `AuthzDenied`/`AuthzAllowed` events on the event bus (principal ref + permission + resource ref + reason + via; never payloads), Prometheus counters `effect_auth_authz_checks_total` / `effect_auth_authz_denials_total`, `authz.check` spans with low-cardinality attributes; sinks are plugins (audit/SIEM) (Q71).
11. **Explicitly not built in v1**: relationship-tuple storage, reverse-index list queries over app data, policy distribution plane (OPAL-style), policy DSL/parser, policy-as-WASM — delegate to Cedar/OPA/SpiceDB/OpenFGA/Permit via the `Authorizer` seam; revisit a first-party relationship store only after the tuple-shaped seam has proven itself in production apps.

## Open questions for the user

1. **Deny-by-default strictness at v1** — options: (a) hard deny-by-default, silent resources (no rules) are inaccessible; (b) deny-by-default but warn at compile time when a route has zero authorization rules; (c) allow-by-default in dev, deny in prod. (a) is the safe default; (c) eases adoption but risks prod surprises.
2. **Default wire behavior for cross-tenant denials** — (a) always 404 for cross-tenant (max enumeration safety), (b) always 403 (simpler, matches AWS IAM/S3 posture), (c) per-route `notFoundOnDeny` flag with a documented default. Recommend (c) with 404 default for id-addressable resources.
3. **Does `plugin-roles` (global RBAC) ship at v1 or v1.1?** — (a) v1 with static code-defined roles only; (b) v1 with DB-backed bindings too; (c) primitives only, no roles plugin until org plugin lands. Note better-auth ships both admin+organization early, so (a) is competitive parity.
4. **Organization plugin timing** (PRD currently says phase 2) — (a) keep phase 2 but freeze the schema outline now (this file's Q68), (b) pull invitations+membership into v1 without teams/dynamic roles, (c) full parity with better-auth org plugin at v1.
5. **First external `Authorizer` adapter** — (a) OpenFGA (Apache-2.0, JS SDK, SQL-backed, easiest self-host), (b) SpiceDB (strongest Zanzibar fidelity + consistency docs), (c) interface only at v1, adapters community-driven. Recommend (a) as the official plugin, (c) acceptable.
6. **List filtering scope** — (a) v1 stub that throws "unsupported" for non-ownership cases (honest), (b) v1 ships SQL pushdown for the ownership+roles subset only, (c) defer entirely to external adapters' `list_objects`. Recommend (a) + doc guidance to use repository-level filters meanwhile.
7. **Service principals in v1** — (a) ship `service` principal kind backed by machine API keys now, (b) user-only principals in v1, add later (union is extensible but callers will match on `_tag`). Recommend (a); cost is small, retrofit cost is high.

## Sources

- https://www.usenix.org/system/files/atc19-pang.pdf (Zanzibar paper, read in full)
- https://www.usenix.org/conference/atc19/presentation/pang
- https://authzed.com/blog/what-is-google-zanzibar
- https://authzed.com/zanzibar (annotated Zanzibar)
- https://authzed.com/docs/spicedb/concepts/consistency
- https://authzed.com/docs/spicedb/modeling/representing-users
- https://authzed.com/docs/authzed/concepts/audit-logging
- https://authzed.com/learn/openfga-alternatives (license comparison)
- https://openfga.dev/docs/
- https://www.ory.com/docs/keto/reference/ory-permission-language
- https://www.ory.com/docs/keto/concepts/relation-tuples
- https://docs.cedarpolicy.com/policies/syntax-grammar.html
- https://cedarpolicy.com/
- https://github.com/cedar-policy
- https://arxiv.org/abs/2403.04651 (Cedar paper)
- https://arxiv.org/html/2407.01688v1 (How We Built Cedar: VGD)
- https://dl.acm.org/doi/10.1145/3663529.3663854
- https://www.amazon.science/blog/how-we-built-cedar-with-automated-reasoning-and-differential-testing
- https://lean-lang.org/use-cases/cedar/
- https://openpolicyagent.org/docs (OPA intro; CNCF graduated)
- https://openpolicyagent.org/docs/management-decision-logs (Decision Logs)
- https://www.osohq.com/academy (Authorization Academy index; authorship)
- https://www.osohq.com/post/why-authorization-is-hard (read in full)
- https://github.com/osohq/oso/blob/main/README.md (library deprecation)
- https://formulae.brew.sh/cask/oso-cloud (deprecated 2026-09-01)
- https://www.npmjs.com/package/oso-cloud
- https://casbin.org/docs/how-it-works (PERM metamodel)
- https://arxiv.org/pdf/1903.09756 (Casbin PERM paper)
- https://casbin.org/blog/authors/ (Yang Luo)
- https://github.com/hsluoyz
- https://docs.permit.io/concepts/pdp/overview
- https://docs.permit.io/integrations/policy-engines/overview/
- https://github.com/permitio/OPAL
- https://docs.cerbos.dev/cerbos/latest/policies/resource_policies.html
- https://docs.cerbos.dev/cerbos/latest/glossary/index.html
- https://better-auth.com/docs/plugins/admin (read; access-control section verified)
- https://better-auth.com/docs/plugins/organization (read; permissions/dynamic-AC/teams verified)
- https://docs.aws.amazon.com/IAM/latest/UserGuide/intro-structure.html (principals, evaluation logic)
- https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4 (403/404 semantics, verbatim)
- https://github.com/Effect-TS/effect/issues/6121 (HttpApiMiddleware in @effect/platform)
- https://www.linkedin.com/in/samjs (Authorization Academy authorship)
- https://www.insightpartners.com/ideas/cloud-security-provider-ory-corp-raises-22-million-in-series-a-round-led-by-insight-partners/ (Ory founders)
- https://kccncchina2018chinese.sched.com/event/FvKJ/tao-daepopen-policy-agenttorin-sandalldaelsstyra (Torin Sandall)
- https://www.youtube.com/watch?v=mstZT431AeQ (Zanzibar talk)
