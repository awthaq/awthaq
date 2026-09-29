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
// header used to document as deferred — a `role_assignments` table,
// `UNIQUE(userId, role)` making `assign` idempotent at the database layer
// too (matching `layerMemory`'s own "assigning an already-held role name
// is a no-op" contract), mirroring `@awthaq/jwt`'s own
// `RevocationStore.layerSql` (`INSERT ... ON CONFLICT ... DO NOTHING`,
// same plugin-owned-table pattern this plugin now follows).
import { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import { AuthEvents, AuthPlugin, ConfigDescriptor, Migrations, Slots } from "@awthaq/core";
import { SubjectResolver as QadiSubjectResolver } from "@awthaq/qadi";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { Role } from "@qadi/core";
import { fromRoles, withAttributes } from "@qadi/core";

/** RRM-003: the role name is not in this deployment's catalog — a typo, or a role since removed. */
export class UnknownRole extends Data.TaggedError("UnknownRole")<{
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
  ) => Effect.Effect<void, UnknownRole>;
  /** RRM-005: a real revoke publishes `auth.roles.revoked`; revoking a role the user never held publishes nothing. */
  readonly revoke: (
    userId: Users.UserId,
    roleName: string,
    options?: RoleChangeOptions,
  ) => Effect.Effect<void>;
  readonly listRoleNames: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * ECS-006: the users currently holding `roleName`. `awthaq seed admin` must find an
   * existing administrator before it grants another, and nothing else can answer "who has
   * this role" (`listRoleNames` goes the other way).
   */
  readonly holders: (roleName: string) => Effect.Effect<ReadonlyArray<Users.UserId>>;
  /**
   * RRM-003: stored assignments whose role name is no longer in the catalog
   * (drift after a rename/removal) — for a startup/doctor check. Empty when
   * catalog and assignments agree.
   */
  readonly listUnknownAssignments: Effect.Effect<
    ReadonlyArray<{ readonly userId: Users.UserId; readonly roleName: string }>
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
    return yield* Effect.die(
      new Error(
        `awthaq: the Roles catalog defines duplicate role name(s): ${duplicates.join(", ")}`,
      ),
    );
  }
  return new Map(rolesConfig.catalog.map((role) => [role.name, role] as const));
});

export const config = (catalog: ReadonlyArray<Role>): Layer.Layer<never> =>
  Layer.succeed(RolesConfig, { catalog });

const emptyNames: ReadonlyArray<string> = [];

const rolesMake: Effect.Effect<RolesShape, never, AuthEvents.AuthEvents> = Effect.gen(function* () {
  const events = yield* AuthEvents.AuthEvents;
  const catalog = yield* validatedCatalog;
  const state = yield* Ref.make(HashMap.empty<Users.UserId, ReadonlyArray<string>>());

  const namesOf = (
    map: HashMap.HashMap<Users.UserId, ReadonlyArray<string>>,
    userId: Users.UserId,
  ): ReadonlyArray<string> => HashMap.get(map, userId).pipe(Option.getOrElse(() => emptyNames));

  return {
    assign: (userId, roleName, options) =>
      Effect.gen(function* () {
        if (!catalog.has(roleName)) return yield* Effect.fail(new UnknownRole({ roleName }));
        const changed = yield* Ref.modify(state, (map) => {
          const existing = namesOf(map, userId);
          return existing.includes(roleName)
            ? ([false, map] as const)
            : ([true, HashMap.set(map, userId, [...existing, roleName])] as const);
        });
        if (changed) {
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
        const changed = yield* Ref.modify(state, (map) => {
          const existing = namesOf(map, userId);
          return existing.includes(roleName)
            ? ([
                true,
                HashMap.set(
                  map,
                  userId,
                  existing.filter((name) => name !== roleName),
                ),
              ] as const)
            : ([false, map] as const);
        });
        if (changed) {
          yield* events.publish({
            _tag: "auth.roles.revoked",
            userId,
            roleName,
            actorUserId: options?.actorId,
          });
        }
      }),
    listRoleNames: (userId) => Ref.get(state).pipe(Effect.map((map) => namesOf(map, userId))),
    holders: (roleName) =>
      Ref.get(state).pipe(
        Effect.map((map) =>
          Array.from(HashMap.entries(map))
            .filter(([, names]) => names.includes(roleName))
            .map(([userId]) => userId),
        ),
      ),
    listUnknownAssignments: Ref.get(state).pipe(
      Effect.map((map) =>
        Array.from(HashMap.entries(map)).flatMap(([userId, names]) =>
          names.filter((name) => !catalog.has(name)).map((roleName) => ({ userId, roleName })),
        ),
      ),
    ),
  };
});

// ---- layerSql -----------------------------------------------------------------

const RoleAssignmentRow = Schema.Struct({
  userId: Schema.String,
  role: Schema.String,
});

const rolesMakeSql: Effect.Effect<RolesShape, never, SqlClient.SqlClient | AuthEvents.AuthEvents> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* AuthEvents.AuthEvents;
    const catalog = yield* validatedCatalog;
    const catalogNames = Array.from(catalog.keys());

    // RETURNING tells a real change from a no-op (`DO NOTHING` returns no row),
    // so only real changes are audited (RRM-005).
    const assignQuery = SqlSchema.findOneOption({
      Request: RoleAssignmentRow,
      Result: RoleAssignmentRow,
      execute: (r) =>
        sql`
          INSERT INTO role_assignments ("userId", role)
          VALUES (${r.userId}, ${r.role})
          ON CONFLICT ("userId", role) DO NOTHING
          RETURNING "userId", role
        `,
    });

    const revokeQuery = SqlSchema.findOneOption({
      Request: RoleAssignmentRow,
      Result: RoleAssignmentRow,
      execute: (r) =>
        sql`DELETE FROM role_assignments WHERE "userId" = ${r.userId} AND role = ${r.role} RETURNING "userId", role`,
    });

    const listUnknownQuery = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: RoleAssignmentRow,
      execute: (names) =>
        names.length === 0
          ? sql`SELECT "userId", role FROM role_assignments`
          : sql`SELECT "userId", role FROM role_assignments WHERE role NOT IN ${sql.in(names)}`,
    });

    const holdersQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ userId: Schema.String }),
      execute: (roleName) => sql`SELECT "userId" FROM role_assignments WHERE role = ${roleName}`,
    });

    const listQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ role: Schema.String }),
      execute: (userId) => sql`SELECT role FROM role_assignments WHERE "userId" = ${userId}`,
    });

    return {
      assign: (userId, roleName, options) =>
        Effect.gen(function* () {
          if (!catalog.has(roleName)) return yield* Effect.fail(new UnknownRole({ roleName }));
          const inserted = yield* assignQuery({ userId, role: roleName }).pipe(Effect.orDie);
          if (Option.isSome(inserted)) {
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
          const removed = yield* revokeQuery({ userId, role: roleName }).pipe(Effect.orDie);
          if (Option.isSome(removed)) {
            yield* events.publish({
              _tag: "auth.roles.revoked",
              userId,
              roleName,
              actorUserId: options?.actorId,
            });
          }
        }),
      listRoleNames: (userId) =>
        listQuery(userId).pipe(
          Effect.map((rows) => rows.map((row) => row.role)),
          Effect.orDie,
        ),
      holders: (roleName) =>
        holdersQuery(roleName).pipe(
          Effect.map((rows) => rows.map((row) => Users.UserId(row.userId))),
          Effect.orDie,
        ),
      listUnknownAssignments: listUnknownQuery(catalogNames).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ userId: Users.UserId(row.userId), roleName: row.role })),
        ),
        Effect.orDie,
      ),
    };
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
    name: "create_role_assignments",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE role_assignments (
            "userId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE ("userId", role)
          )`,
        sqlite: () => sql`
          CREATE TABLE role_assignments (
            "userId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE ("userId", role)
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_role_assignments_user_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`CREATE INDEX role_assignments_user_id ON role_assignments("userId")`,
        sqlite: () => sql`CREATE INDEX role_assignments_user_id ON role_assignments("userId")`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
        const matched = yield* Effect.forEach(names, (name) => {
          const found = catalog.get(name);
          // RRM-003: still dropped (fail closed) but no longer silent — drift
          // after a catalog rename is visible in the logs.
          return found === undefined
            ? Effect.logWarning("awthaq.roles.unknownAssignedRole", {
                userId,
                roleName: name,
              }).pipe(Effect.as([] as ReadonlyArray<Role>))
            : Effect.succeed([found]);
        }).pipe(Effect.map((groups) => groups.flat()));
        const subject = fromRoles({ id: `user:${userId}`, roles: matched });
        return principal.actingAs === undefined
          ? subject
          : withAttributes(subject, {
              actingAs: { type: principal.actingAs.type, id: principal.actingAs.id },
            });
      });
    },
  };
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
  tables: ["role_assignments"],
  migrations: rolesMigrations,
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
   * `@awthaq/core`'s opt-in `Slots.SlotsRegistry`, so an application
   * that provides `Slots.layer` gets a real `SlotConflict` if some other
   * plugin ever claims this same slot too (`Slots.ts`'s own header comment
   * explains why that check is enforced at `Layer`-build time, not by
   * `Auth.make`'s type checker).
   */
  static readonly layer = Slots.override(
    Roles,
    QadiSubjectResolver.SubjectResolver,
    subjectResolverMake,
  ).pipe(Layer.provideMerge(AuthPlugin.layer(Roles, { make: rolesMake })));

  /** BAM-006: the same composition as `layer`, over `rolesMakeSql` instead of the in-memory `rolesMake`. */
  static readonly layerSql = Slots.override(
    Roles,
    QadiSubjectResolver.SubjectResolver,
    subjectResolverMake,
  ).pipe(Layer.provideMerge(AuthPlugin.layer(Roles, { make: rolesMakeSql })));
}
