# @awthaq/roles

The Roles plugin: a global (platform-wide) assignment of role names to users, flattened through qadi's role DAG into `AuthSubject.roles` / `permissions` by overriding the `SubjectResolver` slot (BEH-EA-137–143). Persistence is `Roles.layer` (memory) or `Roles.layerSql` (`role_assignments`, `UNIQUE(userId, role)`).

```ts
const catalog = [editor, owner]                     // built with @qadi/core's role()
const RolesLive = Roles.layerSql.pipe(Layer.provide(Roles.config(catalog)))
```

- **`Roles.config(catalog)` is required for any effect.** With no catalog every user resolves role-less and the layer logs `awthaq.roles.emptyCatalog` at build. A duplicate role name in the catalog fails the build.
- `assign` fails `UnknownRole` for a name outside the catalog; `listUnknownAssignments` reports stored names that have drifted out of it (and resolving such a subject logs `awthaq.roles.unknownAssignedRole`).
- Every real change publishes `auth.roles.assigned` / `auth.roles.revoked` (durably audited; pass `{ actorId }` to record who). `Roles` is a trusted primitive — the gate on *who may call it* is yours (or an HTTP admin surface).
- **Platform authority, not tenant authority** (ADR-EA-017): "is X a platform admin" is `hasRole`; "is X an admin of *this organization*" is `@awthaq/organization`'s `hasRelationship`. Prefix global role names (`platform:support`) so they cannot be mistaken for an organization's `owner`/`admin`.
- **Permission keys match exactly** (qadi's O(1) set membership) — there are no wildcards. Model a family of permissions by listing the keys, expanding a group at definition time with `@qadi/core`'s `createPermissionGroup`, or use an attribute policy for the "any action on this resource" instinct.

See [`spec/behaviors/18-roles-subject-resolver.md`](../../spec/behaviors/18-roles-subject-resolver.md) and [`spec/decisions/017-global-roles-vs-organization-roles.md`](../../spec/decisions/017-global-roles-vs-organization-roles.md).
