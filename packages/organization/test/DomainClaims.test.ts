// `DomainClaims.withClaim` (BEH-EA-317): a claim and the connection row are one unit. The store's own behaviour is
// its RecordsContract suite (`test/contract/DomainClaims.ts`, run by `Contract.test.ts`). The Postgres-only
// "claim lock" block proves the advisory lock key each write holds (CONN-03).
import { Auth } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as DomainClaims from "../src/DomainClaims.ts";
import * as Organization from "../src/Organization.ts";

const MemoryLayer = DomainClaims.layerMemory;

const claim = (
  organizationId: string,
  connectionId: string,
  domains: ReadonlyArray<string>,
  protocol = "oauth",
) =>
  Effect.flatMap(DomainClaims.DomainClaims, (claims) =>
    claims.claim({ organizationId, protocol, connectionId, domains }),
  );

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

describe("DomainClaims.withClaim: the claim and the connection row are one unit", () => {
  it.effect(
    "a failed write gives the claim back (memory: no real transaction to roll it back)",
    () =>
      Effect.gen(function* () {
        const claims = yield* DomainClaims.DomainClaims;
        const transaction = yield* SqlTransaction.SqlTransaction;
        const failed = yield* DomainClaims.withClaim(
          claims,
          transaction,
          {
            organizationId: "org-1",
            protocol: "oauth",
            connectionId: "c1",
            domains: ["acme.example"],
          },
          undefined,
          Effect.fail("the row could not be written"),
          (domain) => `taken ${domain}`,
        ).pipe(Effect.flip);
        assert.strictEqual(failed, "the row could not be written");
        // Nothing is held: another organization may claim the domain.
        yield* claim("org-2", "c2", ["acme.example"]);
        // A failed update restores what the connection claimed before.
        yield* claim("org-2", "c2", ["acme.example"]);
        yield* DomainClaims.withClaim(
          claims,
          transaction,
          {
            organizationId: "org-2",
            protocol: "oauth",
            connectionId: "c2",
            domains: ["other.example"],
          },
          ["acme.example"],
          Effect.fail("the row could not be written"),
          (domain) => `taken ${domain}`,
        ).pipe(Effect.flip);
        assert.strictEqual(
          (yield* claim("org-3", "c3", ["acme.example"]).pipe(Effect.flip))._tag,
          "DomainClaimTaken",
        );
        yield* claim("org-3", "c3", ["other.example"]);
      }).pipe(Effect.provide(Layer.merge(MemoryLayer, SqlTransaction.layerNoop))),
  );
});
