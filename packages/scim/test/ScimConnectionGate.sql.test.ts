// F-04-01 (CONN-F1), Postgres only (skipped without AWTHAQ_POSTGRES_URL): an organization deletion racing a SCIM
// connection create leaves no connection behind, and the create is refused. The interleaving is forced by what each
// session waits on (an advisory-lock waiter), not by elapsed time: the deletion takes the organization lock (its
// order -1 hook) and blocks at the organization-row delete on a latch; the create passes its gate (the deletion is
// uncommitted); the latch opens only once the create waits on the organization lock, so it must see the committed
// deletion in the lifecycle's in-lock re-check.
import { randomInt } from "node:crypto";
import { OrganizationActor, OrganizationDirectory } from "@awthaq/organization";
import { Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as ScimConnections from "../src/ScimConnections.ts";
import { ScimLiveSql } from "./support.ts";

const actor = OrganizationActor.application("ScimConnectionGate.sql.test");

/** `"ok"` for a success, else the failing `_tag`. */
const outcome = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isSuccess(exit)
    ? "ok"
    : (Option.getOrUndefined(Exit.findErrorOption(exit))?._tag ?? "defect");

const countRows = (table: string, where: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql
      .unsafe(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .pipe(Effect.orDie);
    const first = rows[0];
    return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
  });

/** The advisory-lock key the latch trigger waits on: a plain number drawn per run, so two runs against one database never share it (and never one `SqlStore.atomically` derives: those hash text keys). */
const LATCH_KEY = randomInt(1, 2 ** 31);

/** A transaction that holds the latch key until `release`, so a latch trigger blocks until the test lets it go. */
const holdLatch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const held = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const holder = yield* Effect.forkChild(
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(${LATCH_KEY})`;
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(released);
        }),
      )
      .pipe(Effect.orDie),
  );
  yield* Deferred.await(held);
  return {
    release: Deferred.succeed(released, undefined).pipe(Effect.andThen(Fiber.join(holder))),
  };
});

/** Runs `effect` with a trigger on `table` that blocks on the latch key before the write, dropped afterwards whatever happens. */
const withLatchTrigger =
  (options: { readonly name: string; readonly table: string; readonly event: "DELETE" }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .unsafe(
          `CREATE OR REPLACE FUNCTION ${options.name}() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN PERFORM pg_advisory_xact_lock(${LATCH_KEY}); RETURN NULL; END $$`,
        )
        .pipe(Effect.orDie);
      yield* sql
        .unsafe(
          `CREATE TRIGGER ${options.name} BEFORE ${options.event} ON ${options.table}
           FOR EACH STATEMENT EXECUTE FUNCTION ${options.name}()`,
        )
        .pipe(Effect.orDie);
      return yield* effect.pipe(
        Effect.ensuring(
          sql
            .unsafe(`DROP TRIGGER IF EXISTS ${options.name} ON ${options.table}`)
            .pipe(
              Effect.andThen(sql.unsafe(`DROP FUNCTION IF EXISTS ${options.name}()`)),
              Effect.orDie,
            ),
        ),
      );
    });

/** Resolves once a session waits on the advisory lock `key` (a number is the raw key, a string is hashed as `SqlStore.atomically` does), ignoring other test files' waiters in the shared database. */
const waitForAdvisoryWaiter = (key: number | string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const hash = typeof key === "string" ? sql`hashtextextended(${key}, 0)` : sql`${key}::bigint`;
    const rows = yield* sql<{ readonly n: number }>`
      WITH k AS (SELECT ${hash} AS h)
      SELECT count(*)::int AS n FROM pg_locks, k
      WHERE locktype = 'advisory' AND objsubid = 1 AND NOT granted
        AND classid::bigint = ((k.h >> 32) & 4294967295) AND objid::bigint = (k.h & 4294967295)`.pipe(
      Effect.orDie,
    );
    return rows[0]?.n ?? 0;
  }).pipe(
    Effect.repeat({
      until: (waiting) => waiting >= 1,
      schedule: Schedule.spaced("20 millis"),
    }),
    Effect.timeout("10 seconds"),
    Effect.orDie,
    Effect.asVoid,
  );

describe.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(
  "SCIM connection create versus organization deletion (real Postgres, F-04-01)",
  () => {
    it.live(
      "a deletion racing a create leaves no SCIM connection behind, and the create is refused",
      () =>
        Effect.gen(function* () {
          const directory = yield* OrganizationDirectory.OrganizationDirectory;
          const store = yield* ScimConnections.ScimConnectionStore;
          const org = yield* directory.create(actor, {
            owner: Users.UserId("owner-race"),
            name: "race",
            slug: "race",
          });
          const latch = yield* holdLatch;
          const [deleted, created] = yield* withLatchTrigger({
            name: "scim_race_latch_org_delete",
            table: "organization_org",
            event: "DELETE",
          })(
            Effect.gen(function* () {
              const deleting = yield* Effect.forkChild(
                Effect.exit(directory.delete(actor, { organizationId: org.id })),
              );
              yield* waitForAdvisoryWaiter(LATCH_KEY);
              const creating = yield* Effect.forkChild(
                Effect.exit(store.create({ organizationId: org.id, name: "racer" })),
              );
              yield* waitForAdvisoryWaiter(`organization_domain_claim:org:${org.id}`);
              yield* latch.release;
              return [yield* Fiber.join(deleting), yield* Fiber.join(creating)] as const;
            }).pipe(Effect.ensuring(latch.release)),
          );
          assert.deepStrictEqual(
            {
              delete: outcome(deleted),
              create: outcome(created),
              connectionRows: yield* countRows("scim_connection", `"organizationId" = '${org.id}'`),
            },
            {
              delete: "ok",
              create: "InvalidScimConnection",
              connectionRows: 0,
            },
          );
        }).pipe(TestAuth.withoutRequest, Effect.provide(ScimLiveSql("scim_connection_gate_race"))),
      { timeout: 30_000 },
    );
  },
);
