# ADR-EA-017: Global Roles Answer Platform Authority; Organization Relations Answer Tenant Authority

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-017 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented (documentation and guidance; no new mechanism) |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (MTI-007, RRM-006, YL-002) |

---

## Context

awthaq ships two authority mechanisms that a reader can mistake for one:

1. **`@awthaq/roles`** — a *global*, tenant-blind assignment of role names to a user (`Roles.assign(userId, roleName)`), flattened through qadi's role DAG into `AuthSubject.roles` and `.permissions`. It answers `hasRole` / `hasPermission`.
2. **`@awthaq/organization`** — *per-organization* authority: a membership row carries role names (built-in `owner`/`admin`/`member`, `OrganizationConfig.permissionStatements`, and dynamic per-organization roles), and `OrganizationQadi.relationships` answers `hasRelationship("member" | "has-role:<name>" | "<resource>:<action>", ...)` about *a given organization*.

Nothing composes them, and the names collide on sight — both have an `owner` and an `admin`. Three audit findings (MTI-007, RRM-006, YL-002) describe the same seam: a policy author asking "is X an admin?" has two plausible answers and no documented rule for which mechanism owns which question.

Three options were weighed: (A) document the split, with naming guidance, and add no mechanism; (B) let `Roles.assign` take an optional organization scope and surface scoped roles as a Roles-contributed relationship resolver — which duplicates organization roles; (C) change qadi's `AttributeResolver.resolve` to carry a `resourceId` so tenant facts become one mechanism — a breaking upstream API change.

## Decision

**Option A.** The two mechanisms answer different questions and neither substitutes for the other:

| Question | Mechanism | Policy |
|---|---|---|
| "Is this user a *platform* admin/support agent/operator?" — authority that does not depend on which tenant a request touches | `@awthaq/roles` → `AuthSubject.roles`/`permissions` | `hasRole("platform:support")`, `hasPermission(...)` |
| "Is this user an admin/owner/member of *this organization*?", "may they update members *of this organization*?" | `@awthaq/organization` → `OrganizationQadi.relationships` | `hasRelationship("has-role:admin")`, `hasRelationship("member:update")` |

A request that needs both (a platform operator acting inside a tenant) composes them explicitly — `anyOf([hasRole("platform:support"), hasRelationship("member:update")])` — and never assumes a global role implies tenant authority or vice versa.

**Naming guidance, not a hard guard.** Global role names should be prefixed (`platform:support`, `platform:billing`) so a reader never confuses them with an organization's `owner`/`admin`. A hard rejection of catalog names equal to the organization built-ins was considered and **not adopted**: it would break existing catalogs and fixtures that legitimately name a global role `owner`, and the confusion it prevents is one of reading, not of security — the two role stores are never merged.

No third mechanism is built. Organization roles already give per-tenant roles, so scoping `Roles.assign` by organization (option B) would be duplicate infrastructure; qadi's resolver contract is left alone (option C) until a second plugin needs resource-scoped attributes.

## Consequences

**Positive**: one documented rule for "platform vs tenant" authority, worked through in [`02-qadi-path-a-end-to-end.md`](../appendices/02-qadi-path-a-end-to-end.md); no new API surface to maintain; `Roles` stays library-simple.

**Negative**: an application that wants *tenant-scoped* global-style roles must use organization roles (dynamic access control), not `Roles`; an application that reads `AuthSubject.roles` expecting tenant roles will find none. This is the intended boundary, but it is a boundary readers must learn.

**Trade-off accepted**: the naming convention is advisory. A deployment that reuses an organization built-in name for a global role gets confusing policies, not an error.

Implemented as documentation: `packages/roles/src/Roles.ts`'s header, the appendix worked example, and this record. Revisit option C in `../qadi` only if a second plugin needs resource-scoped attributes.
