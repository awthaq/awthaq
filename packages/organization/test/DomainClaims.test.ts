// The store's own behaviour is its RecordsContract suite (`test/contract/DomainClaims.ts`, run by `Contract.test.ts`).
// The Postgres-only "claim lock" block proves the advisory lock key each write holds (CONN-03). The claim and the
// connection row as one unit, including the memory twin's compensation, is covered in
// `OrganizationConnectionLifecycle.test.ts` (BEH-EA-317).
import { Auth } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as DomainClaims from "../src/DomainClaims.ts";
import * as Organization from "../src/Organization.ts";

const lockHeld = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number }>`
      WITH k AS (SELECT hashtextextended(${key}, 0) AS h)
      SELECT count(*)::int AS n FROM pg_locks, k
      WHERE locktype = 'advisory' AND objsubid = 1 AND pid = pg_backend_pid()
        AND classid::bigint = ((k.h >> 32) & 4294967295) AND objid::bigint = (k.h & 4294967295)`;
    return (rows[0]?.n ?? 0) > 0;
  });

// Postgres only (BEH-EA-317, CONN-03): each write of org-1 holds that organization's advisory lock, and no other's.
describe.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)("the claim lock", () => {
  const Live = TestAuth.layer(Auth.make([Organization.Organization]), {
    records: "sql",
    suite: "organization_DomainClaimsLock",
    services: Organization.config({}),
  });

  const operations: ReadonlyArray<
    readonly [string, (claims: DomainClaims.DomainClaimsShape) => Effect.Effect<void, unknown>]
  > = [
    [
      "claim",
      (claims) =>
        claims.claim({
          organizationId: "org-1",
          protocol: "oauth",
          connectionId: "c1",
          domains: ["a.example"],
        }),
    ],
    ["release", (claims) => claims.release("org-1", "c1")],
    ["releaseAllForOrganization", (claims) => claims.releaseAllForOrganization("org-1")],
  ];

  for (const [name, run] of operations) {
    it.effect(`${name} holds the organization's lock until the outer transaction ends`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const claims = yield* DomainClaims.DomainClaims;
        const held = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* run(claims);
            return {
              org1: yield* lockHeld("organization_domain_claim:org:org-1"),
              org2: yield* lockHeld("organization_domain_claim:org:org-2"),
            };
          }),
        );
        assert.deepStrictEqual(held, { org1: true, org2: false });
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );
  }
});
