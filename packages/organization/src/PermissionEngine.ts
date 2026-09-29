// @awthaq/organization — PermissionEngine
//
// spec.md's "Roles & permissions — a self-contained, statement-based
// engine": a pure domain module with no service tag and no HTTP endpoint of
// its own. `Organization.ts` calls into this directly to gate its own
// mutating endpoints; ticket 15's dynamic access control reuses the same
// `canGrant` guard for its own self-escalation check.
//
// Deliberately not a `Context.Service` — every function here is a plain,
// synchronous computation over already-loaded data (a caller's held role
// names, and a `resource -> statements` map already resolved by whoever
// calls in). Nothing here talks to a database or to qadi.

/** A resource name mapped to the actions held against it, e.g. `{ organization: ["update", "delete"] }`. */
export type Statements = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * spec.md's defaults, in three strictly ordered tiers (OHS-005, better-auth
 * parity): owner can do everything including deleting the organization;
 * admin manages the organization (`update` only), its members, invitations,
 * teams and roles but can neither delete the organization nor confer an
 * owner-only statement (`canGrant` bounds every assignment/invite/role edit);
 * member is read-only (an empty statement set — read/list operations are
 * never gated by this engine at all, only mutations are, so "read-only" falls
 * out of member simply holding no mutating statements).
 */
export const defaultStatements: Readonly<Record<"owner" | "admin" | "member", Statements>> = {
  owner: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    role: ["create", "read", "update", "delete"],
  },
  admin: {
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    role: ["create", "read", "update", "delete"],
  },
  member: {
    organization: [],
    member: [],
    invitation: [],
    team: [],
    role: [],
  },
};

/** RZS-005/N8: the three built-in tiers, whose statements no custom or dynamic role may redefine. */
export const isBuiltInRole = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(defaultStatements, name);

/** OHS-004: the union of two statement sets — org-level authority plus team-scoped authority. */
export const mergeStatements = (a: Statements, b: Statements): Statements => {
  const merged: Record<string, ReadonlyArray<string>> = { ...a };
  for (const [resource, actions] of Object.entries(b)) {
    const existing = merged[resource] ?? [];
    merged[resource] = Array.from(new Set([...existing, ...actions]));
  }
  return merged;
};

/**
 * Given the role names a membership holds (built-in and/or custom/dynamic)
 * and a lookup of every role name this organization currently recognizes,
 * computes the union of every held role's statements. An unrecognized role
 * name (present in `roleNames` but absent from `statementsByRole`) simply
 * contributes nothing — it is never a defect, since a dynamic role can be
 * deleted out from under a membership that still names it.
 */
export const effectivePermissions = (
  roleNames: ReadonlyArray<string>,
  statementsByRole: ReadonlyMap<string, Statements>,
): Statements =>
  roleNames.reduce<Statements>((acc, name) => {
    const statements = statementsByRole.get(name);
    return statements === undefined ? acc : mergeStatements(acc, statements);
  }, {});

/** Whether an already-computed effective permission set includes a specific resource/action. */
export const hasPermission = (permissions: Statements, resource: string, action: string): boolean =>
  (permissions[resource] ?? []).includes(action);

/**
 * ticket 15's self-escalation guard: `requested` (the statements a caller
 * is trying to grant, e.g. to a new dynamic role) must be a subset of
 * `granterPermissions` (the caller's own effective statements) — every
 * resource/action pair requested must already be held by the granter.
 */
export const canGrant = (requested: Statements, granterPermissions: Statements): boolean =>
  Object.entries(requested).every(([resource, actions]) => {
    const held = granterPermissions[resource] ?? [];
    return actions.every((action) => held.includes(action));
  });

/**
 * Merges an application's own custom static roles
 * (`OrganizationConfig.permissionStatements`) and an organization's dynamic
 * roles with the three built-in defaults, then resolves a lookup map ready
 * for `effectivePermissions`.
 *
 * RZS-005/N8: precedence is built-in > static custom > dynamic (a `Map`
 * built from entries keeps the last duplicate, so the strongest source is
 * listed last). A dynamic role named `owner`, or one that shadows a static
 * custom role, can therefore never replace those statements — the guard
 * lives here, not only in `createRole`, so a row written around the plugin
 * (or one that predates the reservation) is inert too.
 */
export const statementsByRoleFrom = (
  customStatements: Readonly<Record<string, Statements>>,
  dynamicStatements?: Readonly<Record<string, Statements>>,
): ReadonlyMap<string, Statements> =>
  new Map<string, Statements>([
    ...Object.entries(dynamicStatements ?? {}),
    ...Object.entries(customStatements),
    ...Object.entries(defaultStatements),
  ]);
