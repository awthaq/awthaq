// CONN-03/CONN-05, phase 4 Wave 0 (architecture deepening batch 3): the Postgres race oracle for the OIDC connection
// store's claim and release order. Postgres only: without AWTHAQ_POSTGRES_URL the file is skipped, so `pnpm test`
// is unaffected. Each case forces its interleaving with a `pg_sleep` trigger created in the suite schema and dropped
// in a finalizer, then asserts outcome classes and final row counts, never which fiber finished first.
// Red against the pre-phase stores (a deadlock between the claim-then-row update and the row-then-release remove, the
// opposite-order owner-row deadlock between two organizations, and the deletion-vs-create orphan); green once 04-03
// (lock, sorted owner inserts) and 04-05 (claims-first lifecycle, in-lock re-check) land. Never edited after this commit.
import { Auth, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationConnections from "../src/OrganizationConnections.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";

const actor = OrganizationActor.application("OrganizationConnectionLifecycle.sql.test");

// The `RealLive` composition: the stores over the real SQL records, so it compiles unchanged when their requirements change.
const Live = Layer.mergeAll(
  OrganizationConnections.layerStore,
  OrganizationConnections.connectionsOnOrganizationDelete,
).pipe(
  Layer.provideMerge(OrganizationConnections.OrganizationConnections.layer),
  Layer.provideMerge(
    TestAuth.layer(Auth.make([Organization.Organization]), {
      records: "sql",
      suite: "organization_ConnectionLifecycleRace",
      services: Organization.config({}),
    }),
  ),
);

const oidcInput = (
  organizationId: string,
  emailDomains: ReadonlyArray<string>,
): OrganizationConnections.ConnectionCreateInput => ({
  organizationId,
  kind: "oidc",
  name: "Acme SSO",
  issuer: "https://idp.acme.example",
  discoveryUrl: "https://idp.acme.example/.well-known/openid-configuration",
  clientId: "client-1",
  clientSecret: Redacted.make("super-secret"),
  emailDomains,
});

const organization = (slug: string) =>
  Effect.flatMap(OrganizationDirectory.OrganizationDirectory, (directory) =>
    directory.create(actor, { owner: Users.UserId(`owner-${slug}`), name: slug, slug }),
  );

const create = (organizationId: string, emailDomains: ReadonlyArray<string>) =>
  Effect.flatMap(OrganizationConnections.OrganizationConnectionStore, (store) =>
    store.create(actor, oidcInput(organizationId, emailDomains)),
  );

/** `"ok"` for a success, else the failing `_tag` (`StoreUnavailable` is how a deadlock victim surfaces). */
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

/** Runs `effect` with a trigger on `table` that sleeps before the write, dropped afterwards whatever happens. */
const withSleepTrigger =
  (options: {
    readonly name: string;
    readonly table: string;
    readonly event: "INSERT" | "UPDATE" | "DELETE";
    readonly scope: "ROW" | "STATEMENT";
    readonly seconds: number;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .unsafe(
          `CREATE OR REPLACE FUNCTION ${options.name}() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN PERFORM pg_sleep(${options.seconds}); RETURN ${options.scope === "ROW" ? "NEW" : "NULL"}; END $$`,
        )
        .pipe(Effect.orDie);
      yield* sql
        .unsafe(
          `CREATE TRIGGER ${options.name} BEFORE ${options.event} ON ${options.table}
           FOR EACH ${options.scope} EXECUTE FUNCTION ${options.name}()`,
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

describe.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(
  "OIDC connection lifecycle races (real Postgres, CONN-03/CONN-05)",
  () => {
    it.live(
      "an update racing a remove of the same connection ends with nothing left and no deadlock",
      () =>
        Effect.gen(function* () {
          const store = yield* OrganizationConnections.OrganizationConnectionStore;
          const org = yield* organization("a");
          const view = yield* create(org.id, ["one.example"]);

          const [updated, removed] = yield* withSleepTrigger({
            name: "race_sleep_connection_update",
            table: "organization_oauth_connection",
            event: "UPDATE",
            scope: "STATEMENT",
            seconds: 0.3,
          })(
            Effect.gen(function* () {
              const updating = yield* Effect.forkChild(
                Effect.exit(
                  store.update(actor, org.id, view.id, { emailDomains: ["two.example"] }),
                ),
              );
              yield* Effect.sleep(Duration.millis(50));
              const removal = yield* Effect.exit(store.remove(actor, org.id, view.id));
              return [yield* Fiber.join(updating), removal] as const;
            }),
          );

          const updateOutcome = outcome(updated);
          assert.deepStrictEqual(
            {
              remove: outcome(removed),
              update:
                updateOutcome === "ok" || updateOutcome === "ConnectionRecordNotFound"
                  ? "ok or ConnectionRecordNotFound"
                  : updateOutcome,
              storeUnavailable: [updated, removed].filter(
                (exit) => outcome(exit) === "StoreUnavailable",
              ).length,
              connectionRows: yield* countRows(
                "organization_oauth_connection",
                `id = '${view.id}'`,
              ),
              domainRows: yield* countRows(
                "organization_oauth_connection_domain",
                `"connectionId" = '${view.id}'`,
              ),
              claimRows: yield* countRows(
                "organization_domain_claim",
                `"connectionId" = '${view.id}'`,
              ),
              ownerRows: yield* countRows(
                "organization_domain_owner",
                `"organizationId" = '${org.id}'`,
              ),
            },
            {
              remove: "ok",
              update: "ok or ConnectionRecordNotFound",
              storeUnavailable: 0,
              connectionRows: 0,
              domainRows: 0,
              claimRows: 0,
              ownerRows: 0,
            },
          );
        }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
      { timeout: 30_000 },
    );

    it.live(
      "two organizations claiming the same two domains in opposite order: one wins, the other is refused, no deadlock",
      () =>
        Effect.gen(function* () {
          const first = yield* organization("a");
          const second = yield* organization("b");

          const [a, b] = yield* withSleepTrigger({
            name: "race_sleep_owner_insert",
            table: "organization_domain_owner",
            event: "INSERT",
            scope: "ROW",
            seconds: 0.3,
          })(
            Effect.all(
              [
                Effect.exit(create(first.id, ["x.example", "y.example"])),
                Effect.exit(create(second.id, ["y.example", "x.example"])),
              ],
              { concurrency: 2 },
            ),
          );

          const sql = yield* SqlClient.SqlClient;
          const owners = yield* sql
            .unsafe<{ readonly domain: string; readonly organizationId: string }>(
              `SELECT domain, "organizationId" FROM organization_domain_owner
               WHERE domain IN ('x.example', 'y.example') ORDER BY domain`,
            )
            .pipe(Effect.orDie);
          const winner = outcome(a) === "ok" ? first.id : second.id;
          assert.deepStrictEqual(
            {
              storeUnavailable: [a, b].filter((exit) => outcome(exit) === "StoreUnavailable")
                .length,
              outcomes: [outcome(a), outcome(b)].toSorted(),
              owners: owners.map((row) => ({
                domain: row.domain,
                winner: row.organizationId === winner,
              })),
            },
            {
              storeUnavailable: 0,
              outcomes: ["ConnectionDomainTaken", "ok"],
              owners: [
                { domain: "x.example", winner: true },
                { domain: "y.example", winner: true },
              ],
            },
          );
        }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
      { timeout: 30_000 },
    );

    it.live(
      "an organization deletion racing a create for it leaves no connection, claim or owner row behind",
      () =>
        Effect.gen(function* () {
          const directory = yield* OrganizationDirectory.OrganizationDirectory;
          const org = yield* organization("a");

          const [deleted, created] = yield* withSleepTrigger({
            name: "race_sleep_org_delete",
            table: "organization_org",
            event: "DELETE",
            scope: "STATEMENT",
            seconds: 0.5,
          })(
            Effect.gen(function* () {
              const deleting = yield* Effect.forkChild(
                Effect.exit(directory.delete(actor, { organizationId: org.id })),
              );
              yield* Effect.sleep(Duration.millis(100));
              const creation = yield* Effect.exit(create(org.id, ["acme.example"]));
              return [yield* Fiber.join(deleting), creation] as const;
            }),
          );

          assert.deepStrictEqual(
            {
              delete: outcome(deleted),
              createIsNotStoreUnavailable: outcome(created) !== "StoreUnavailable",
              connectionRows: yield* countRows(
                "organization_oauth_connection",
                `"organizationId" = '${org.id}'`,
              ),
              claimRows: yield* countRows(
                "organization_domain_claim",
                `"organizationId" = '${org.id}'`,
              ),
              ownerRows: yield* countRows(
                "organization_domain_owner",
                `"organizationId" = '${org.id}'`,
              ),
            },
            {
              delete: "ok",
              createIsNotStoreUnavailable: true,
              connectionRows: 0,
              claimRows: 0,
              ownerRows: 0,
            },
          );
        }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
      { timeout: 30_000 },
    );
  },
);
