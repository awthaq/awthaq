// @awthaq/roles — Roles plugin
//
// spec/behaviors/18-roles-subject-resolver.md, BEH-EA-138 through BEH-EA-141.
// The one plugin that overrides `@awthaq/qadi`'s `SubjectResolver` slot
// (BEH-EA-138) with a real implementation: `UserPrincipal` gets its assigned
// role names looked up and flattened through qadi's role DAG into
// `AuthSubject.roles`/`permissions` (BEH-EA-139); every other principal kind
// — `Anonymous`, `ApiKey`, `Service`, and a `UserPrincipal`'s own
// `actingAs` — is delegated to `@awthaq/qadi`'s own
// `resolveIdentityOnly`, so installing this plugin never changes how those
// kinds resolve (BEH-EA-140/141's scope-to-permission mapping for `ApiKey`/
// `Service` principals lives once, in `@awthaq/qadi`'s `SubjectResolver.ts`,
// which this delegation reaches — not repeated here).
//
// **Global, not tenant-scoped (ADR-EA-025, MTI-007).** `Roles` answers "is
// this user a *platform* admin/support/operator" — `AuthSubject.roles`/
// `permissions`, `hasRole`/`hasPermission`. "Is this user an admin of *this
// organization*" is `@awthaq/organization`'s `OrganizationQadi.relationships`
// (`hasRelationship("has-role:admin")`, `hasRelationship("member:update")`).
// The two are never merged; prefix global role names (`platform:support`) so
// they cannot be mistaken for an organization's `owner`/`admin`.
//
// BAM-006 (.issues/high): `layerSql` closes the persistence gap this
// header used to document as deferred — a `roles_assignments` table,
// `UNIQUE(userId, role)` making `assign` idempotent at the database layer
// too (matching `layerMemory`'s own "assigning an already-held role name
// is a no-op" contract), mirroring `@awthaq/jwt`'s own
// `RevocationStore.layerSql` (`INSERT ... ON CONFLICT ... DO NOTHING`,
// same plugin-owned-table pattern this plugin now follows).
import { Api } from "@awthaq/api";
import { Defects, Errors, Users } from "@awthaq/core";
import {
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  Migrations,
  Slots,
} from "@awthaq/core";
import { SubjectResolver as QadiSubjectResolver } from "@awthaq/qadi";
import * as RoleAssignments from "./RoleAssignments.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Role } from "@qadi/core";
import { fromRoles, withAttributes } from "@qadi/core";

/** RRM-003: the role name is not in this deployment's catalog — a typo, or a role since removed. */
export class UnknownRole extends Data.TaggedError("Roles/UnknownRole")<{
  readonly roleName: string;
}> {}

/** RRM-005: who is making the change, recorded on the audit event. `Roles` itself is a trusted primitive and authorizes nothing. */
export interface RoleChangeOptions {
  readonly actorId?: Users.UserId | undefined;
}

export interface RolesShape {
  /**
   * Idempotent: assigning an already-held role name is a no-op (and publishes
   * nothing). RRM-003: fails `UnknownRole` for a name absent from the catalog.
   * RRM-005: a real change publishes `auth.roles.assigned` (durably audited).
   * The authorization gate for *who may call this* lives on an HTTP surface
   * (`RolesAdmin`, YL-009), not here.
   */
  readonly assign: (
    userId: Users.UserId,
    roleName: string,
    options?: RoleChangeOptions,
  ) => Effect.Effect<void, UnknownRole | Errors.StoreUnavailable>;
  /** RRM-005: a real revoke publishes `auth.roles.revoked`; revoking a role the user never held publishes nothing. */
  readonly revoke: (
    userId: Users.UserId,
    roleName: string,
    options?: RoleChangeOptions,
  ) => Effect.Effect<void, Errors.StoreUnavailable>;
  readonly listRoleNames: (
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<string>, Errors.StoreUnavailable>;
  /**
   * ECS-006: the users currently holding `roleName`. `awthaq seed admin` must find an
   * existing administrator before it grants another, and nothing else can answer "who has
   * this role" (`listRoleNames` goes the other way).
   */
  readonly holders: (
    roleName: string,
  ) => Effect.Effect<ReadonlyArray<Users.UserId>, Errors.StoreUnavailable>;
  /**
   * RRM-003: stored assignments whose role name is no longer in the catalog
   * (drift after a rename/removal) — for a startup/doctor check. Empty when
   * catalog and assignments agree.
   */
  readonly listUnknownAssignments: Effect.Effect<
    ReadonlyArray<{ readonly userId: Users.UserId; readonly roleName: string }>,
    Errors.StoreUnavailable
  >;
}

export interface RolesConfigShape {
  /** BEH-EA-139: the whole role DAG this deployment defines, built with `@qadi/core`'s own `role()`. */
  readonly catalog: ReadonlyArray<Role>;
}

/**
 * RRM-010: the empty default is fail-closed (every user resolves role-less) but
 * a plugin installed without `Roles.config([...])` does nothing at all — so
 * `Roles.config(catalog)` is *required* for any effect, and building the layer
 * with no catalog logs `awthaq.roles.emptyCatalog`.
 */
export const RolesConfig: Context.Reference<RolesConfigShape> = Context.Reference(
  "awthaq/roles/Config",
  { defaultValue: (): RolesConfigShape => ({ catalog: [] }) },
);

/**
 * RRM-004: the catalog, validated once, then indexed by name. A repeated role
 * name is a configuration error the layer refuses to build over — it used to
 * collapse silently, last wins — exactly the position qadi's own
 * `resolveRoleGraph` takes (`DuplicateRoleDefinition`: "silently picking one is
 * a guess this library should not make"). (The catalog holds by-value `Role`s,
 * which cannot form an inheritance cycle, so a duplicate name is the one
 * defect left to catch; `resolveRoleGraph` itself takes name-referenced
 * definitions.)
 */
const validatedCatalog = Effect.gen(function* () {
  const rolesConfig = yield* RolesConfig;
  const names = rolesConfig.catalog.map((role) => role.name);
  const duplicates = Array.from(new Set(names.filter((name, i) => names.indexOf(name) !== i)));
  if (duplicates.length > 0) {
    return yield* Defects.invalidConfiguration(
      "catalog",
      `awthaq: the Roles catalog defines duplicate role name(s): ${duplicates.join(", ")}`,
    );
  }
  return new Map(rolesConfig.catalog.map((role) => [role.name, role] as const));
});

export const config = (catalog: ReadonlyArray<Role>): Layer.Layer<never> =>
  Layer.succeed(RolesConfig, { catalog });

/**
 * The one domain implementation of `Roles` (plan 08): catalog validation, `UnknownRole` and the audit events,
 * written once over whichever `RoleAssignments` store the composition provides (`Roles.records.memory` or
 * `Roles.records.sql`).
 */
const rolesMake = Effect.gen(function* () {
  const events = yield* AuthEvents.AuthEvents;
  const catalog = yield* validatedCatalog;
  const store = yield* RoleAssignments.RoleAssignments;
  const catalogNames = Array.from(catalog.keys());

  return {
    assign: (userId, roleName, options) =>
      Effect.gen(function* () {
        if (!catalog.has(roleName)) return yield* Effect.fail(new UnknownRole({ roleName }));
        // RRM-005: only a real change is audited.
        if (yield* store.add(userId, roleName)) {
          yield* events.publish({
            _tag: "auth.roles.assigned",
            userId,
            roleName,
            actorUserId: options?.actorId,
          });
        }
      }),
    revoke: (userId, roleName, options) =>
      Effect.gen(function* () {
        if (yield* store.remove(userId, roleName)) {
          yield* events.publish({
            _tag: "auth.roles.revoked",
            userId,
            roleName,
            actorUserId: options?.actorId,
          });
        }
      }),
    listRoleNames: store.roleNames,
    holders: store.holders,
    listUnknownAssignments: store.outside(catalogNames),
  } satisfies RolesShape;
});

/**
 * BAM-006 (.issues/high): the migration this plugin's own header used to
 * defer — `UNIQUE(userId, role)` makes `assign` idempotent at the database
 * layer too, matching `layerMemory`'s own "assigning an already-held role
 * name is a no-op" contract. Columns left unquoted under `pg`, like
 * `@awthaq/jwt`'s own `jwtMigrations`: this table's own queries above
 * already reference every column unquoted.
 */
const rolesMigrations: Migrations.Migrations = [
  {
    name: "create_roles_assignments",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE roles_assignments (
            "userId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE ("userId", role)
          )`,
        sqlite: () => sql`
          CREATE TABLE roles_assignments (
            "userId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE ("userId", role)
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_roles_assignments_user_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`CREATE INDEX roles_assignments_user_id ON roles_assignments("userId")`,
        sqlite: () => sql`CREATE INDEX roles_assignments_user_id ON roles_assignments("userId")`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
];

/**
 * Factored out of `Roles.layer` so `layerSql` can share it: builds the
 * `SubjectResolver` override from whichever `RolesShape` implementation
 * gets merged underneath (`rolesMake`/`rolesMakeSql`) — see `Roles.layer`'s
 * own doc comment for why the self-reference to `Roles` here is safe.
 */
const subjectResolverMake = Effect.gen(function* () {
  const roles = yield* Roles;
  const rolesConfig = yield* RolesConfig;
  const catalog = yield* validatedCatalog;
  // RRM-010: an empty catalog is fail-closed, but almost always a forgotten
  // `Roles.config([...])` — say so once, at build.
  if (rolesConfig.catalog.length === 0) {
    yield* Effect.logWarning(
      "awthaq.roles.emptyCatalog",
      "the Roles plugin has an empty catalog: every user resolves with no roles. Provide Roles.config([...]).",
    );
  }

  return {
    resolve: (principal: Api.Principal) => {
      if (principal._tag !== "User") {
        return Effect.succeed(QadiSubjectResolver.resolveIdentityOnly(principal));
      }
      return Effect.gen(function* () {
        const userId = Users.UserId(principal.ref.id);
        const names = yield* roles.listRoleNames(userId);
        const noRoles: ReadonlyArray<Role> = [];
        const matched = yield* Effect.forEach(names, (name) => {
          const found = catalog.get(name);
          // RRM-003: still dropped (fail closed) but no longer silent — drift
          // after a catalog rename is visible in the logs.
          return found === undefined
            ? Effect.logWarning("awthaq.roles.unknownAssignedRole", {
                userId,
                roleName: name,
              }).pipe(Effect.as(noRoles))
            : Effect.succeed([found]);
        }).pipe(Effect.map((groups) => groups.flat()));
        const subject = fromRoles({ id: `user:${userId}`, roles: matched });
        // BEH-EA-142/BEH-EA-258: the same attributes the default resolver attaches (actingAs, amr, aal, ...).
        return withAttributes(subject, QadiSubjectResolver.principalAttributes(principal));
      });
    },
  };
});

/**
 * CSG-001, wayfinder ticket 30: this plugin's part of `AccountErasure.eraseAccount`.
 * Revokes every role the erased user holds through the plugin's own `revoke` (so each
 * removal is still audited as `auth.roles.revoked`; the audit rows are pseudonymized
 * at the end of the erasure). Part of `Roles.layer`/`layerSql`, which therefore
 * require `Erasure.ErasureRegistry`.
 */
export const rolesExport = DataExport.contribute({
  id: "roles",
  make: Effect.gen(function* () {
    const roles = yield* Roles;
    return (subject: DataExport.DataExportSubject) =>
      roles.listRoleNames(subject.userId).pipe(Effect.map((names) => ({ roles: [...names] })));
  }),
});

export const rolesErasure = Erasure.contribute({
  id: "roles",
  make: Effect.gen(function* () {
    const roles = yield* Roles;
    return (subject: Erasure.ErasureSubject) =>
      roles
        .listRoleNames(subject.userId)
        .pipe(
          Effect.flatMap((names) =>
            Effect.forEach(names, (name) => roles.revoke(subject.userId, name), { discard: true }),
          ),
        );
  }),
});

export class Roles extends AuthPlugin.Service<Roles, RolesShape>()("roles", {
  apiVersion: 1,
  // BEH-EA-018/roadmap M3: no HTTP contract of its own — this plugin's whole
  // job is the `SubjectResolver` override, per this module's own header
  // comment. Role administration over HTTP is the separate, opt-in `RolesAdmin`
  // plugin (YL-009), so `Auth.make([Roles])` stays contract-less. `HttpApi.make("auth")` with no `.add()` call is a real,
  // zero-group `HttpApi<"auth", never>`, which contributes nothing to
  // `Auth.make`'s composed `api` (`never extends GroupsFor<"roles">` holds
  // trivially, the same bottom-type reasoning `Auth.ts`'s own comments use
  // for `Layer`'s contravariant `ROut`).
  contract: HttpApi.make("auth"),
  tables: {
    roles_assignments: AuthPlugin.Table.global("global roles, ADR-EA-025"),
  },
  migrations: rolesMigrations,
  // Plan 08 (BEH-EA-T4): the assignment store, memory and SQL, matched. The catalog (`Roles.config`) stays config.
  records: RoleAssignments.records,
  // The catalog is listed by role name (each `Role` carries its whole permission tree).
  config: [
    ConfigDescriptor.make(RolesConfig, {
      project: (value) => ({ catalog: value.catalog.map((role) => role.name) }),
      audit: (value) =>
        value.catalog.length === 0
          ? [
              ConfigDescriptor.finding(
                "warning",
                "roles-empty-catalog",
                "the Roles catalog is empty: every user resolves with no roles (provide Roles.config([...]))",
              ),
            ]
          : [],
    }),
  ],
}) {
  /**
   * Self-referential the same way `Password`'s own `static readonly layer`
   * is (that class's doc comment explains why this is safe): `Roles` is
   * read, as a `Context.Service` tag, from inside a lazily-run `Effect.gen`
   * body that is not evaluated until this very layer is built, so the
   * forward reference to the not-yet-finished class statement is fine.
   *
   * `Layer.provideMerge(subjectResolverOverride, ownLayer)` — `ownLayer`
   * (`AuthPlugin.layer(Roles, {make: rolesMake})`) provides `Roles` itself;
   * `subjectResolverOverride` (built via `Slots.override`, BEH-EA-021)
   * requires exactly that `Roles` to resolve role assignments, so folding
   * it underneath satisfies that requirement and the composed result
   * exposes both `Roles` and the overridden `SubjectResolver` in its
   * `ROut` — the real, working half of BEH-EA-138 this module's own header
   * comment describes. `Slots.override` also registers this claim with
   * `@awthaq/core`'s `Slots.SlotsRegistry` (MA-005: required; `Auth.make`
   * provides one per composition, a standalone build provides `Slots.layer`),
   * so a `SlotConflict` fails the build if some other
   * plugin ever claims this same slot too (`Slots.ts`'s own header comment
   * explains why that check is enforced at `Layer`-build time, not by
   * `Auth.make`'s type checker).
   */
  static readonly layer = Slots.override(
    Roles,
    QadiSubjectResolver.SubjectResolver,
    subjectResolverMake,
  ).pipe(
    Layer.provideMerge(
      AuthPlugin.layer(Roles, {
        make: rolesMake,
        contributes: Layer.mergeAll(rolesErasure, rolesExport),
      }),
    ),
  );
}
