// P20a/AH-003, decision 36 Tier 4: the second half of
// 01-contract-and-persistence/05-persistence-stratum.feature — keyset pagination (BEH-EA-036) and
// the migration Rules (BEH-EA-037..040). Migrations run for real against in-memory SQLite: the
// fixture plugins' `up` effects read the table they depend on, so a wrong order fails the
// migration itself instead of only changing a name. INV-EA-016's "reject a migration that alters a
// shared table" has no implementation to test (PV-252) and stays `@skip` in the feature.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { Admin } from "@awthaq/admin";
import { ApiKey } from "@awthaq/api-key";
import { Migration } from "@awthaq/cli";
import { Auth, Migrations, UserFields } from "@awthaq/core";
import { Jwt } from "@awthaq/jwt";
import { Organization } from "@awthaq/organization";
import { Passkey } from "@awthaq/passkey";
import { Roles } from "@awthaq/roles";
import { Scim } from "@awthaq/scim";
import { TestAuth } from "@awthaq/test";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assertTypeGate, cell, isObject, put, take, type World } from "./FoundationsWorld.ts";
import { MigOauth, MigPassword, migrateSqlite } from "./MigrationFixtures.ts";
import { insertSession, insertUser, withDatabase } from "./PersistenceStratumWorld.ts";
import { layerEvaluations, PasswordFixture } from "./PluginFixtures.ts";
import { Profile, fieldKey } from "./UserFieldsFixture.ts";

const GATES = "PersistenceTypeGates.ts";
const GATES_PLUGIN = "PluginTypeGates.ts";

const strings = cell("strings", (value): value is ReadonlyArray<string> => Array.isArray(value));
const numbers = cell("numbers", (value): value is ReadonlyArray<number> => Array.isArray(value));
const ledger = cell(
  "ledger",
  (
    value,
  ): value is {
    readonly core: ReadonlyArray<string>;
    readonly plugin: ReadonlyArray<string>;
    readonly tables: ReadonlyArray<string>;
    readonly composed: ReadonlyArray<string>;
  } => isObject(value) && "core" in value && "plugin" in value,
);

/** The linker's tuple for BEH-EA-038: `oauth` depends on `password`. */
const composeLinked = () => Auth.make([MigPassword, MigOauth]);

const BASE = DateTime.makeUnsafe("2026-03-01T00:00:00.000Z");
/** Each fixture session expires at its own `createdAt`, so list from just before the first. */
const before = DateTime.subtract(BASE, { seconds: 1 });

/** Every shipped plugin class that owns migrations, in an order where cross-plugin reads find their tables. */
const SHIPPED = [
  Roles.Roles,
  Organization.Organization,
  Jwt.Jwt,
  Passkey.Passkey,
  Admin.Admin,
  ApiKey.ApiKey,
  Scim.Scim,
];

/** Five sessions a second apart, listed two at a time; the pages and cursors that came back. */
const paginate = withDatabase(
  Effect.gen(function* () {
    const sessions = yield* Repositories.SessionsRepository;
    const user = yield* insertUser("pages@example.com");
    for (let i = 0; i < 5; i++) {
      yield* insertSession(user.id, `h${i}`, DateTime.add(BASE, { seconds: i }));
    }
    const first = yield* sessions.listByUser(user.id, before, undefined, 2);
    const cursor = Option.getOrUndefined(first.nextCursor);
    const second = yield* sessions.listByUser(user.id, before, cursor, 2);
    const third = yield* sessions.listByUser(
      user.id,
      before,
      Option.getOrUndefined(second.nextCursor),
      2,
    );
    return { first, cursor, second, third };
  }),
);

export const persistenceMigrationSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-036: keyset pagination ----

  Given("a {string} query for a user's sessions", function* (query: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(query, "listByUser");
  });

  Given(
    "a {string} query for a user's sessions with more rows beyond the requested limit",
    function* (query: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.equal(query, "listByUser");
    },
  );

  When(
    "the query is called with a cursor derived from a prior page's last \\(createdAt, id\\)",
    function* () {
      const { first, cursor, second } = yield* paginate;
      assert.ok(cursor !== undefined);
      yield* put(strings, [
        first.items.map((row) => row.id).join(","),
        second.items.map((row) => row.id).join(","),
        cursor.id,
      ]);
    },
  );

  Then("the query accepts the cursor", function* () {
    const [firstPage, secondPage, cursorId] = yield* take(strings);
    const firstIds = (firstPage ?? "").split(",");
    const secondIds = (secondPage ?? "").split(",");
    assert.equal(firstIds.length, 2);
    assert.equal(secondIds.length, 2);
    // The next page starts strictly after the cursor's row: nothing repeated, nothing skipped.
    assert.ok(firstIds.every((id) => !secondIds.includes(id)));
    assert.equal(cursorId, firstIds[1]);
  });

  Then("the query's interface has no offset parameter", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    assertTypeGate("keyset-only-no-offset", GATES, ["@ts-expect-error", "offset"]);
  });

  When("the query is called", function* () {
    const { first, third } = yield* paginate;
    const last = first.items.at(-1);
    const cursor = Option.getOrUndefined(first.nextCursor);
    yield* put(strings, [
      cursor === undefined ? "none" : "some",
      String(last !== undefined && cursor?.id === last.id),
      String(
        last !== undefined &&
          cursor !== undefined &&
          DateTime.Equivalence(cursor.createdAt, last.createdAt),
      ),
      Option.isSome(third.nextCursor) ? "some" : "none",
    ]);
  });

  Then(
    "the returned page is accompanied by a next cursor derived from the page's last \\(createdAt, id\\)",
    function* () {
      const [present, sameId, sameCreatedAt, lastPageCursor] = yield* take(strings);
      assert.equal(present, "some");
      assert.equal(sameId, "true");
      assert.equal(sameCreatedAt, "true");
      // The short final page (one row left) carries no cursor: nothing beyond it.
      assert.equal(lastPageCursor, "none");
    },
  );

  Given(
    "two session rows with an identical createdAt timestamp down to the millisecond",
    function* () {
      yield* Effect.void; // an assertion-only step: nothing to await
      // Arranged in the When, which needs the rows and the queries on one database.
    },
  );

  When("a paginated query orders by \\(createdAt, id\\)", function* () {
    const outcome = yield* withDatabase(
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* insertUser("ties@example.com");
        const sameInstant = DateTime.add(BASE, { seconds: 30 });
        yield* insertSession(user.id, "tie-a", sameInstant);
        yield* insertSession(user.id, "tie-b", sameInstant);
        const all = yield* sessions.listByUser(user.id, before, undefined, 10);
        const again = yield* sessions.listByUser(user.id, before, undefined, 10);
        // One row at a time, following cursors: neither tied row is skipped or repeated.
        const one = yield* sessions.listByUser(user.id, before, undefined, 1);
        const two = yield* sessions.listByUser(
          user.id,
          before,
          Option.getOrUndefined(one.nextCursor),
          1,
        );
        return {
          ids: all.items.map((row) => row.id),
          again: again.items.map((row) => row.id),
          stepwise: [...one.items, ...two.items].map((row) => row.id),
          createdAts: all.items.map((row) => DateTime.toEpochMillis(row.createdAt)),
        };
      }),
    );
    yield* put(strings, [
      outcome.ids.join(","),
      outcome.again.join(","),
      outcome.stepwise.join(","),
      outcome.createdAts.join(","),
    ]);
  });

  Then(
    "the {string} tiebreaker produces one deterministic order between the two rows",
    function* (column: string) {
      assert.equal(column, "id");
      const [ids, again, stepwise, createdAts] = yield* take(strings);
      const list = (ids ?? "").split(",");
      assert.equal(list.length, 2);
      const stamps = (createdAts ?? "").split(",");
      assert.equal(stamps[0], stamps[1], "the two rows share one createdAt");
      assert.deepEqual(list, [...list].sort(), "ties are ordered by id ascending");
      assert.equal(again, ids, "the same query returns the same order");
      assert.equal(stepwise, ids, "paging one row at a time yields the same order");
    },
  );

  // ---- BEH-EA-037: static, declarative migrations ----

  Given("a plugin exposing a static {string} member", function* (member: string) {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.equal(member, "migrations");
    assert.ok(PasswordFixture.migrations.length > 0);
  });

  When("the plugin's migrations are read", function* () {
    const evaluationsBefore = layerEvaluations.password;
    const composed = Auth.make([PasswordFixture]).migrations;
    assert.ok(composed.length > 0);
    yield* put(numbers, [layerEvaluations.password - evaluationsBefore]);
  });

  Then("they resolve without evaluating the plugin's {string} Layer", function* (_layer: string) {
    assert.deepEqual(yield* take(numbers), [0]);
  });

  When("the plugin's migrations are read with no configuration provided", function* () {
    // Plain synchronous reads of the class's own members: nothing is provided, nothing is run.
    yield* put(
      strings,
      PasswordFixture.migrations.map((migration) => migration.name),
    );
  });

  Then("the migrations resolve successfully", function* () {
    assert.deepEqual(yield* take(strings), ["create_password_account"]);
  });

  When("the migrations are inspected", function* () {
    const built = Auth.make([MigPassword]);
    const ran = yield* migrateSqlite(built.migrations);
    yield* put(strings, [
      built.migrations
        .map((migration) => `${migration.name}:${Effect.isEffect(migration.up)}`)
        .join(","),
      ran.applied.map(([id, name]) => `${id}:${name}`).join(","),
      ran.pluginRows.map((row) => row.name).join(","),
    ]);
  });

  Then("each migration is an @effect\\/sql Migrator record keyed by its name", function* () {
    const [declared, applied, ledgerNames] = yield* take(strings);
    const declaredEntries = (declared ?? "").split(",");
    assert.ok(
      declaredEntries.length > 0 && declaredEntries.every((entry) => entry.endsWith(":true")),
    );
    const names = declaredEntries.map((entry) => entry.replace(/:true$/, ""));
    // The migrator applied exactly these, by id and name, and recorded them by that name.
    assert.deepEqual(
      (applied ?? "").split(",").map((entry) => entry.split(":")[1]),
      names,
    );
    assert.deepEqual((ledgerNames ?? "").split(","), names);
  });

  // ---- BEH-EA-038: the linker's deterministic sequence ----

  Given(
    "an installed plugin set including {string} and {string}",
    function* (first: string, second: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual([first, second], ["password", "oauth"]);
    },
  );

  Given(
    "an installed plugin set including {string} \\(depending on {string}\\) and {string} \\(depending on {string}\\)",
    function* (first: string, firstDependency: string, second: string, secondDependency: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual(
        [first, firstDependency, second, secondDependency],
        ["password", "core", "oauth", "core"],
      );
    },
  );

  Given(
    "a plugin {string} whose table has a foreign key into a table owned by {string}, and {string} declares {string} in dependsOn",
    function* (table: string, owner: string, plugin: string, dependency: string) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual(
        [table, owner, plugin, dependency],
        ["oauth_account", "password", "oauth", "password"],
      );
      assert.deepEqual(
        MigOauth.dependsOn.map((dep) => dep.id),
        ["password"],
      );
    },
  );

  When("the linker composes the migration sequence", function* () {
    const built = composeLinked();
    const ran = yield* migrateSqlite(built.migrations);
    yield* put(ledger, {
      core: ran.coreRows.map((row) => row.name),
      plugin: ran.pluginRows.map((row) => row.name),
      tables: ran.tables,
      composed: built.migrations.map((migration) => migration.name),
    });
  });

  Then("core's migrations appear first in the sequence", function* () {
    const result = yield* take(ledger);
    assert.ok(result.core.length > 0, "core's own ledger holds its migrations");
    // The plugin migrations read core's `users` table: had any run first, applying it would have failed.
    assert.ok(result.plugin.length > 0 && result.tables.includes("users"));
    // The linker's list is plugin-only: core keeps its own ledger and is applied first.
    assert.ok(result.core.every((name) => !result.composed.includes(name)));
  });

  Then("each plugin's migrations follow their dependsOn topological order", function* () {
    const { composed } = yield* take(ledger);
    const at = (id: string) => composed.findIndex((name) => name.includes(`_${id}_`));
    assert.ok(at("password") >= 0 && at("oauth") > at("password"), composed.join(", "));
  });

  Then("each migration is re-keyed {string}", function* (pattern: string) {
    assert.equal(pattern, "NNNN_<plugin>_<name>");
    const { composed } = yield* take(ledger);
    composed.forEach((name, index) => {
      assert.match(
        name,
        new RegExp(`^${String(index + 1).padStart(4, "0")}_(password|oauth)_[a-z_]+$`),
      );
    });
  });

  When("the linker composes the migration sequence twice, independently", function* () {
    yield* put(strings, [
      composeLinked()
        .migrations.map((migration) => migration.name)
        .join(","),
      composeLinked()
        .migrations.map((migration) => migration.name)
        .join(","),
    ]);
  });

  Then("both compositions produce the identical ordered, re-keyed sequence", function* () {
    const [first, second] = yield* take(strings);
    assert.ok((first ?? "").length > 0);
    assert.equal(first, second);
  });

  Then(
    "{string}'s migration creating its table runs before {string}'s migration that references it",
    function* (owner: string, referencing: string) {
      assert.deepEqual([owner, referencing], ["password", "oauth"]);
      const { plugin } = yield* take(ledger);
      const created = plugin.findIndex((name) =>
        name.endsWith("_password_create_password_account"),
      );
      const referenced = plugin.findIndex((name) => name.endsWith("_oauth_create_oauth_account"));
      assert.ok(created >= 0 && referenced > created, plugin.join(", "));
    },
  );

  // ---- BEH-EA-039: no diffing machinery in v1 ----

  Given(
    "an application composing {string}, {string}, and {string}",
    function* (...names: ReadonlyArray<string>) {
      yield* Effect.void; // an assertion-only step: nothing to await
      assert.deepEqual(names, ["Auth.make", "auth.layer", "auth.migrations"]);
    },
  );

  When("the application boots", function* () {
    const built = Auth.make([MigPassword]);
    // Boot: the composed layer builds and the migrations apply — with nothing but the linker's list.
    yield* Effect.scoped(Layer.build(built.layer));
    yield* migrateSqlite(built.migrations);
    yield* put(strings, [...Object.keys(built), ...Object.keys(Migrations), ...Object.keys(Auth)]);
  });

  Then(
    "it does not depend on a snapshot-diff planner, a checksum ledger, or a live-database drift check",
    function* () {
      for (const name of yield* take(strings)) {
        assert.doesNotMatch(name, /snapshot|checksum|drift|planner|diff/i, name);
      }
    },
  );

  Given("a CLI schema-diff feature that will need the composed migration set", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    // The consumer is `@awthaq/cli`'s `Migration`: it is exercised in the When.
  });

  When("the CLI feature is built", function* () {
    const built = Auth.make([MigPassword, MigOauth]);
    const report = yield* Effect.gen(function* () {
      // The runner's two steps (what `migration apply` does): core first, then the linker's list.
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      yield* Migrations.run(built.migrations);
      return yield* Migration.inspect(built);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped);
    const plugins = report.ledgers.find((entry) => entry.ledger === "plugins");
    yield* put(strings, [
      built.migrations.map((migration) => migration.name).join(","),
      Migration.pluginKnown(built)
        .map((entry) => entry.name)
        .join(","),
      String(plugins?.pending.length),
      String(plugins?.applied.length),
    ]);
  });

  Then(
    "it consumes the same {string} value the runtime already produces",
    function* (value: string) {
      assert.equal(value, "auth.migrations");
      const [runtime, cli] = yield* take(strings);
      assert.ok((runtime ?? "").length > 0);
      assert.equal(cli, runtime);
    },
  );

  Then("it does not require a separate migration representation from the runtime", function* () {
    // Applying the runtime's own list leaves nothing pending in the CLI's reading of it.
    const [, , pending, applied] = yield* take(strings);
    assert.equal(pending, "0");
    assert.equal(applied, "4");
  });

  // ---- BEH-EA-040: migration ownership, as far as it is enforced ----

  Given("the shipped plugins that declare migrations", function* () {
    yield* Effect.void; // an assertion-only step: nothing to await
    assert.ok(SHIPPED.every((plugin) => plugin.migrations.length > 0));
  });

  When("core's migrations and then each plugin's migrations run", function* () {
    const outcome = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      const tableRows = () =>
        sql<{ readonly name: string; readonly sql: string }>`
          SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
      const coreTables = yield* tableRows();
      const created: Array<string> = [];
      for (const plugin of SHIPPED) {
        const known = new Set((yield* tableRows()).map((row) => row.name));
        yield* Migrations.run(plugin.migrations, { table: `ledger_${plugin.id}` });
        for (const row of yield* tableRows()) {
          if (!known.has(row.name) && !row.name.startsWith("ledger_")) {
            created.push(`${plugin.id}|${row.name}`);
          }
        }
      }
      const afterwards = yield* tableRows();
      const coreUnchanged = coreTables.every((row) =>
        afterwards.some((later) => later.name === row.name && later.sql === row.sql),
      );
      return { created, coreUnchanged };
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped);
    yield* put(strings, [...outcome.created, String(outcome.coreUnchanged)]);
  });

  Then(
    "every table a plugin created is named {string} under its own id",
    function* (pattern: string) {
      assert.equal(pattern, "<plugin>_<table>");
      const entries = (yield* take(strings)).slice(0, -1);
      assert.ok(entries.length > 0, "the shipped plugins created tables");
      for (const entry of entries) {
        const [plugin, table] = entry.split("|");
        assert.ok(
          table?.startsWith(`${plugin}_`),
          `${plugin} created "${table}", outside its own prefix`,
        );
      }
    },
  );

  Then("the tables core created are unchanged", function* () {
    assert.equal((yield* take(strings)).at(-1), "true");
  });

  // ---- PV-252/REQ-EA-106: `runPluginContractTests` refuses a migration that alters a core table ----

  Given(
    "a plugin migration that attempts to ALTER TABLE {string} directly",
    function* (table: string) {
      yield* put(strings, [table]);
    },
  );

  When("the plugin's migrations are validated", function* () {
    const [table] = yield* take(strings);
    assert.ok(table !== undefined);
    const failed: Array<string> = [];
    const pending: Array<Promise<void>> = [];
    TestAuth.runPluginContractTests(
      {
        describe: (_name, body) => body(),
        it: (name, body) => {
          pending.push(
            Promise.resolve()
              .then(body)
              .catch((error: unknown) => {
                failed.push(`${name} :: ${error instanceof Error ? error.message : String(error)}`);
              }),
          );
        },
        fail: (message) => {
          throw new Error(message);
        },
      },
      () => ({
        id: "own",
        apiVersion: 1,
        contract: { identifier: "auth", groups: { own: HttpApiGroup.make("own") } },
        tables: [],
        dependsOn: [],
        layer: Layer.empty,
        migrations: [
          {
            name: "alter_shared_table",
            up: Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.unsafe(`ALTER TABLE ${table} ADD COLUMN own_flag TEXT`),
            ),
          },
        ],
      }),
      { options: [{}] },
    );
    yield* Effect.promise(() => Promise.all(pending));
    yield* put(strings, [table, ...failed]);
  });

  Then("the migration is rejected", function* () {
    const [table, ...failures] = yield* take(strings);
    assert.ok(
      failures.some((message) => message.includes("INV-EA-016")),
      `the ownership check failed for ${table}: ${failures.join(" | ")}`,
    );
    yield* put(strings, [table ?? "", ...failures]);
  });

  Then("the shared table {string} is not altered", function* (table: string) {
    // The check runs the migration on its own throwaway database, so the composition's database is
    // never touched; the failure names the table it caught being altered.
    const [, ...failures] = yield* take(strings);
    assert.ok(failures.some((message) => message.includes(`"${table}"`)));
    const untouched = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      return yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped);
    assert.ok(!untouched.some((column) => column.name === "own_flag"));
  });

  // ---- REQ-EA-107/108: a shared table is extended only through `AuthPlugin.userFields` (SAM-004) ----

  /** Core's migrations, then the composition's, on a fresh database; what `users` looks like afterwards. */
  const usersColumnsAfter = (migrations: Migrations.Migrations) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      const before = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM pragma_table_info('users')`;
      yield* Migrations.run(migrations);
      const after = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
      }>`SELECT * FROM pragma_table_info('users')`;
      return { before: before.map((column) => column.name), after };
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped);

  Given(
    "a plugin that needs to attach a derived value to the shared {string} table",
    function* (table: string) {
      assert.equal(table, "users");
      yield* Effect.void;
    },
  );

  When(
    "the plugin contributes that value through the declared extension point {string}",
    function* (point: string) {
      assert.equal(point, "AuthPlugin.userFields");
      yield* Effect.void;
    },
  );

  Then(
    "the plugin's own migrations do not modify the shared {string} table",
    function* (table: string) {
      assert.equal(table, "users");
      // The plugin ships no migration of its own; every migration the composition runs for it is the linker's.
      assert.deepEqual(Profile.migrations, []);
      const linked = Auth.make([Profile]).migrations;
      assert.ok(linked.length > 0);
      assert.ok(linked.every((migration) => migration.name.includes("add_user_field_")));
    },
  );

  Then(
    "the extension is visible only through the declared extension point: the column the linker generated, and the composition's typed user fields",
    function* () {
      const built = Auth.make([Profile]);
      const { before, after } = yield* usersColumnsAfter(built.migrations);
      const added = after.map((column) => column.name).filter((name) => !before.includes(name));
      assert.deepEqual(added.sort(), [
        "profile_billingTier",
        "profile_isElevated",
        "profile_nickname",
      ]);
      assert.ok(Object.keys(built.userFields).includes(fieldKey("nickname")));
      assert.ok(built.manifest.userFields.some((entry) => entry.key === fieldKey("nickname")));
    },
  );

  Given("a declared extension point for the shared {string} table", function* (table: string) {
    assert.equal(table, "users");
    yield* Effect.void;
  });

  When("a plugin contributes an extension through that point", function* () {
    yield* Effect.void;
  });

  Then("the extension is a primitive, nullable scalar column: text, real or boolean", function* () {
    const built = Auth.make([Profile]);
    const { after } = yield* usersColumnsAfter(built.migrations);
    const extension = after.filter((column) => column.name.startsWith("profile_"));
    assert.ok(extension.length > 0);
    for (const column of extension) {
      assert.ok(
        ["TEXT", "REAL", "INTEGER"].includes(column.type),
        `${column.name}: ${column.type}`,
      );
      assert.equal(column.notnull, 0, `${column.name} must be nullable`);
    }
    assert.deepEqual(built.manifest.userFields.map((entry) => entry.kind).sort(), [
      "boolean",
      "text",
      "text",
    ]);
  });

  Then("a declaration that is not one scalar is refused when the plugin is defined", function* () {
    yield* Effect.void;
    assert.throws(
      () =>
        UserFields.describePlugin("bad", { mixed: Schema.Union([Schema.String, Schema.Number]) }),
      (error) => error instanceof UserFields.InvalidDeclaration,
    );
  });

  Then("it is never an unmediated ALTER TABLE from the plugin's migration code", function* () {
    yield* Effect.void;
    // The plugin declares data, not DDL: what alters `users` is the linker's generated migration, and
    // a plugin's own attempt is refused by the contract suite (REQ-EA-106).
    assert.deepEqual(Profile.migrations, []);
    assertTypeGate("table-foreign-prefix", GATES_PLUGIN, ["@ts-expect-error"]);
  });
});
