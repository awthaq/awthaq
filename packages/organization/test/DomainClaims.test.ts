// `DomainClaims.withClaim` (BEH-EA-317): a claim and the connection row are one unit. The store's own behaviour is
// its RecordsContract suite (`test/contract/DomainClaims.ts`, run by `Contract.test.ts`).
import { SqlTransaction } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DomainClaims from "../src/DomainClaims.ts";

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
