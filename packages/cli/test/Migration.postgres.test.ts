// BEH-EA-204 on a real Postgres — the hazard P09 documented: `Migrator`'s Postgres branch checks its
// ledger with `select 'name'::regclass`, and `@effect/sql-pg` 4.0.0-rc.116 cannot decode OID 2205, so
// once the ledger exists a *second* migrator run on the same database (any redeploy) fails and wrecks
// the connection. The CLI's own client (`Database.layerFor`) registers the client-scoped codec
// `packages/sql/README.md` documents; this suite proves `migration apply` / `status` survive it.
//
// Skips (not fails) without `AWTHAQ_POSTGRES_URL`, like every Postgres suite here; `pnpm run test:pg`
// runs it. It works in its own schema (`search_path` in the URL) so it never touches another suite's tables.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Runtime from "effect/Runtime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Database from "../src/Database.ts";
import * as Migration from "../src/Migration.ts";
import * as Output from "../src/Output.ts";
import { passwordAndRoles } from "./support/TestApp.ts";

const postgresUrl = process.env["AWTHAQ_POSTGRES_URL"];
const schema = "t_cli_migration";

const scopedUrl = (url: string) => `${url}${url.includes("?") ? "&" : "?"}search_path=${schema}`;

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Output.Output>, url: string) =>
  Effect.gen(function* () {
    const { captured, layer } = yield* Output.capture(false);
    const exit = yield* Effect.exit(
      effect.pipe(Effect.provide(Layer.merge(layer, Database.layerFor(scopedUrl(url))))),
    );
    return { exit, stdout: yield* Ref.get(captured.stdout) };
  });

const code = <A, E>(exit: Exit.Exit<A, E>) => {
  if (!Exit.isFailure(exit)) return 0;
  const error = Exit.findErrorOption(exit);
  return error._tag === "Some" ? Runtime.getErrorExitCode(error.value) : -1;
};

const yes = { yes: true, dryRun: false, allowEmpty: false };

describe.skipIf(postgresUrl === undefined)("migration status|apply on Postgres", () => {
  it.effect("apply, then status and a second apply on the already-migrated database (regclass codec)", () =>
    Effect.gen(function* () {
      const url = postgresUrl ?? "";
      // A scratch schema, dropped and recreated so the run starts from nothing.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
      }).pipe(Effect.provide(Database.layerFor(url)));

      const first = yield* run(Migration.apply(passwordAndRoles, yes), url);
      assert.strictEqual(code(first.exit), 0);
      assert.isTrue(first.stdout.some((line) => line.startsWith("applied 22 migration(s)")));

      // The ledgers now exist. This is the call that used to fail: status reads them...
      const status = yield* run(Migration.status(passwordAndRoles), url);
      assert.strictEqual(code(status.exit), 0);
      assert.include(status.stdout[0] ?? "", "20 applied, 0 pending");

      // ... and a later apply runs the migrator again over the *existing* ledgers. Leave one plugin
      // migration pending (as if a newer release added it), so the migrator really does run
      // `select 'ledger'::regclass` against a ledger that exists — the call that wrecked the connection.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP INDEX ${schema}.role_assignments_user_id`);
        yield* sql.unsafe(`DELETE FROM ${schema}.awthaq_plugin_migrations WHERE migration_id = 2`);
      }).pipe(Effect.provide(Database.layerFor(url)));
      const again = yield* run(Migration.apply(passwordAndRoles, yes), url);
      assert.strictEqual(code(again.exit), 0);
      assert.isTrue(again.stdout.some((line) => line.startsWith("applied 1 migration(s)")));

      // Nothing pending now: exit 4, or 0 with --allow-empty.
      const nothing = yield* run(Migration.apply(passwordAndRoles, yes), url);
      assert.strictEqual(code(nothing.exit), 4);
      const allowed = yield* run(
        Migration.apply(passwordAndRoles, { ...yes, allowEmpty: true }),
        url,
      );
      assert.strictEqual(code(allowed.exit), 0);
    }),
  );
});
