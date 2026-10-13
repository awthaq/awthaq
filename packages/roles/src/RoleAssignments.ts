// @awthaq/roles — RoleAssignments
//
// Plan 08 (BEH-EA-T4): the one record store behind the Roles plugin: which role names each user holds. `Roles`
// is written once over it (catalog validation, `UnknownRole`, the audit events); this module owns only the rows,
// in two implementations, memory and SQL, which `Roles.records` bundles as a matched pair. Before, `Roles.layer`
// and `Roles.layerSql` each carried their own copy of the domain logic over a different storage.

import { Errors, Users } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export interface RoleAssignmentsShape {
  /** `true` when the assignment is new, `false` when the user already held the role (a no-op). */
  readonly add: (
    userId: Users.UserId,
    roleName: string,
  ) => Effect.Effect<boolean, Errors.StoreUnavailable>;
  /** `true` when the user held the role and no longer does, `false` when they never held it. */
  readonly remove: (
    userId: Users.UserId,
    roleName: string,
  ) => Effect.Effect<boolean, Errors.StoreUnavailable>;
  readonly roleNames: (
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<string>, Errors.StoreUnavailable>;
  readonly holders: (
    roleName: string,
  ) => Effect.Effect<ReadonlyArray<Users.UserId>, Errors.StoreUnavailable>;
  /** Assignments whose role name is not among `catalogNames` (drift after a catalog rename). */
  readonly outside: (
    catalogNames: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly userId: Users.UserId; readonly roleName: string }>,
    Errors.StoreUnavailable
  >;
}

/** A record store: the `/records/` key segment is what `AuthPlugin.layer` checks the bundle against. */
export class RoleAssignments extends Context.Service<RoleAssignments, RoleAssignmentsShape>()(
  "awthaq/roles/records/RoleAssignments",
) {}

const emptyNames: ReadonlyArray<string> = [];

/** Single-process, lost on restart: every assignment is a `Ref` entry. */
export const layerMemory = Layer.effect(
  RoleAssignments,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<Users.UserId, ReadonlyArray<string>>());
    type Held = HashMap.HashMap<Users.UserId, ReadonlyArray<string>>;
    const namesOf = (map: Held, userId: Users.UserId): ReadonlyArray<string> =>
      HashMap.get(map, userId).pipe(Option.getOrElse(() => emptyNames));

    return RoleAssignments.of({
      add: (userId, roleName) =>
        Ref.modify(state, (map): [boolean, Held] => {
          const existing = namesOf(map, userId);
          return existing.includes(roleName)
            ? [false, map]
            : [true, HashMap.set(map, userId, [...existing, roleName])];
        }),
      remove: (userId, roleName) =>
        Ref.modify(state, (map): [boolean, Held] => {
          const existing = namesOf(map, userId);
          return existing.includes(roleName)
            ? [
                true,
                HashMap.set(
                  map,
                  userId,
                  existing.filter((name) => name !== roleName),
                ),
              ]
            : [false, map];
        }),
      roleNames: (userId) => Ref.get(state).pipe(Effect.map((map) => namesOf(map, userId))),
      holders: (roleName) =>
        Ref.get(state).pipe(
          Effect.map((map) =>
            Array.from(HashMap.entries(map))
              .filter(([, names]) => names.includes(roleName))
              .map(([userId]) => userId),
          ),
        ),
      outside: (catalogNames) =>
        Ref.get(state).pipe(
          Effect.map((map) =>
            Array.from(HashMap.entries(map)).flatMap(([userId, names]) =>
              names
                .filter((name) => !catalogNames.includes(name))
                .map((roleName) => ({ userId, roleName })),
            ),
          ),
        ),
    });
  }),
);

const RoleAssignmentRow = Schema.Struct({
  userId: Schema.String,
  role: Schema.String,
});

/** Over the `roles_assignments` table (`UNIQUE(userId, role)` makes `add` idempotent at the database layer too). */
export const layerSql = Layer.effect(
  RoleAssignments,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // RETURNING tells a real change from a no-op (`DO NOTHING` returns no row), so only real changes are audited (RRM-005).
    const assignQuery = SqlSchema.findOneOption({
      Request: RoleAssignmentRow,
      Result: RoleAssignmentRow,
      execute: (r) =>
        sql`
          INSERT INTO roles_assignments ("userId", role)
          VALUES (${r.userId}, ${r.role})
          ON CONFLICT ("userId", role) DO NOTHING
          RETURNING "userId", role
        `,
    });

    const revokeQuery = SqlSchema.findOneOption({
      Request: RoleAssignmentRow,
      Result: RoleAssignmentRow,
      execute: (r) =>
        sql`DELETE FROM roles_assignments WHERE "userId" = ${r.userId} AND role = ${r.role} RETURNING "userId", role`,
    });

    const listUnknownQuery = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: RoleAssignmentRow,
      execute: (names) =>
        names.length === 0
          ? sql`SELECT "userId", role FROM roles_assignments`
          : sql`SELECT "userId", role FROM roles_assignments WHERE role NOT IN ${sql.in(names)}`,
    });

    const holdersQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ userId: Schema.String }),
      execute: (roleName) => sql`SELECT "userId" FROM roles_assignments WHERE role = ${roleName}`,
    });

    const listQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ role: Schema.String }),
      execute: (userId) => sql`SELECT role FROM roles_assignments WHERE "userId" = ${userId}`,
    });

    return RoleAssignments.of({
      add: (userId, roleName) =>
        assignQuery({ userId, role: roleName }).pipe(
          Effect.map(Option.isSome),
          Errors.orStoreUnavailable("Roles.assign"),
        ),
      remove: (userId, roleName) =>
        revokeQuery({ userId, role: roleName }).pipe(
          Effect.map(Option.isSome),
          Errors.orStoreUnavailable("Roles.revoke"),
        ),
      roleNames: (userId) =>
        listQuery(userId).pipe(
          Effect.map((rows) => rows.map((row) => row.role)),
          Errors.orStoreUnavailable("Roles.listRoleNames"),
        ),
      holders: (roleName) =>
        holdersQuery(roleName).pipe(
          Effect.map((rows) => rows.map((row) => Users.UserId(row.userId))),
          Errors.orStoreUnavailable("Roles.holders"),
        ),
      outside: (catalogNames) =>
        listUnknownQuery(catalogNames).pipe(
          Effect.map((rows) =>
            rows.map((row) => ({ userId: Users.UserId(row.userId), roleName: row.role })),
          ),
          Errors.orStoreUnavailable("Roles.listUnknownAssignments"),
        ),
    });
  }),
);

/** Plan 08 (BEH-EA-T4): the plugin's record store as two matched layers, `Roles.records`. */
export const records = { memory: layerMemory, sql: layerSql };
