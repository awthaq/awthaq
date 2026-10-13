// BEH-EA-317 (plan 10 item 7): `DomainClaims`, one contract suite over both layers. `layerSql` is migrated
// through the plugin's own real `migrations`, so the owner table's primary key is a real database constraint.
import { Migrations } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { TestAuth, TestSql } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as DomainClaims from "../src/DomainClaims.ts";
import * as Organization from "../src/Organization.ts";
import { ambientOrganization, vitestFramework } from "./support.ts";

const SqlLive = TestSql.layer("organization_DomainClaims");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = DomainClaims.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);
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

const suite = (
  name: string,
  layer:
    | Layer.Layer<DomainClaims.DomainClaims | SqlClient.SqlClient, unknown>
    | Layer.Layer<DomainClaims.DomainClaims, unknown>,
): void => {
  describe(name, () => {
    it.effect(
      "another organization cannot claim a domain, over any protocol, and nothing changes",
      () =>
        Effect.gen(function* () {
          yield* claim("org-1", "c1", ["acme.example"], "oauth");
          const clash = yield* claim("org-2", "c2", ["free.example", "acme.example"], "saml").pipe(
            Effect.flip,
          );
          assert.strictEqual(clash._tag, "DomainClaimTaken");
          assert.strictEqual(clash._tag === "DomainClaimTaken" ? clash.domain : "", "acme.example");
          // The refused claim took nothing, not even the domain listed before the clash.
          yield* claim("org-3", "c3", ["free.example"], "saml");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("the owner may route a domain over both protocols and several connections", () =>
      Effect.gen(function* () {
        yield* claim("org-1", "c1", ["acme.example"], "oauth");
        yield* claim("org-1", "c2", ["acme.example", "acme.test"], "saml");
        // Re-asserting the same set is idempotent.
        yield* claim("org-1", "c2", ["acme.example", "acme.test"], "saml");
        const other = yield* claim("org-2", "c3", ["acme.test"], "oauth").pipe(Effect.flip);
        assert.strictEqual(other._tag, "DomainClaimTaken");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("a domain is released only when its last claiming connection lets go", () =>
      Effect.gen(function* () {
        const claims = yield* DomainClaims.DomainClaims;
        yield* claim("org-1", "c1", ["acme.example"], "oauth");
        yield* claim("org-1", "c2", ["acme.example"], "saml");
        yield* claims.release("org-1", "c1");
        assert.strictEqual(
          (yield* claim("org-2", "x", ["acme.example"]).pipe(Effect.flip))._tag,
          "DomainClaimTaken",
        );
        yield* claims.release("org-1", "c2");
        yield* claim("org-2", "x", ["acme.example"]);
        // Releasing what is not claimed is a no-op.
        yield* claims.release("org-1", "never-existed");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("claiming a smaller set releases the domains dropped, and only those", () =>
      Effect.gen(function* () {
        yield* claim("org-1", "c1", ["a.example", "b.example"]);
        yield* claim("org-1", "c1", ["a.example"]);
        yield* claim("org-2", "c2", ["b.example"]);
        assert.strictEqual(
          (yield* claim("org-2", "c3", ["a.example"]).pipe(Effect.flip))._tag,
          "DomainClaimTaken",
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect("releasing an organization frees every domain it owned, and no other's", () =>
      Effect.gen(function* () {
        const claims = yield* DomainClaims.DomainClaims;
        yield* claim("org-1", "c1", ["a.example"], "oauth");
        yield* claim("org-1", "c2", ["b.example"], "saml");
        yield* claim("org-2", "c3", ["c.example"], "oauth");
        yield* claims.releaseAllForOrganization("org-1");
        yield* claim("org-3", "x", ["a.example", "b.example"]);
        assert.strictEqual(
          (yield* claim("org-3", "y", ["c.example"]).pipe(Effect.flip))._tag,
          "DomainClaimTaken",
        );
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("DomainClaims (layerMemory)", MemoryLayer);
suite("DomainClaims (layerSql)", SqlLayer);

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

// ---- tenant isolation: both tables, both adapters -------------------------------------------------------

let isolationCounter = 0;

const using = <A, E, R>(f: (claims: DomainClaims.DomainClaimsShape) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(DomainClaims.DomainClaims, f);

const isolationInsert = Effect.gen(function* () {
  isolationCounter += 1;
  const organizationId = yield* ambientOrganization;
  const id = `isolation-${isolationCounter}`;
  const domain = `${id}.example`;
  yield* claim(organizationId, id, [domain]);
  return { id, organizationId, domain };
});

const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : `${row.organizationId}-other`;

interface Row {
  readonly id: string;
  readonly organizationId: string;
  readonly domain: string;
}

const isolationMethods: {
  readonly [K in keyof DomainClaims.DomainClaimsShape]: TestAuth.MethodClass<
    Row,
    DomainClaims.DomainClaims
  >;
} = {
  claim: {
    keyed: {
      run: (row, as) =>
        using((claims) =>
          Effect.gen(function* () {
            // Another organization presenting this row's connection id and domain must change nothing of the owner's.
            const outcome = yield* claims
              .claim({
                organizationId: orgOf(row, as),
                protocol: "oauth",
                connectionId: row.id,
                domains: [row.domain, `${row.domain}.more`],
              })
              .pipe(Effect.exit);
            return as === "owner" && outcome._tag === "Success";
          }),
        ),
    },
  },
  release: {
    keyed: {
      run: (row, as) =>
        using((claims) =>
          Effect.gen(function* () {
            yield* claims.release(orgOf(row, as), row.id);
            // Released means a third organization can now take the domain.
            const outcome = yield* claim(`${row.organizationId}-third`, `third-${row.id}`, [
              row.domain,
            ]).pipe(Effect.exit);
            return outcome._tag === "Success";
          }),
        ),
    },
  },
  releaseAllForOrganization: {
    keyed: {
      run: (row, as) =>
        using((claims) =>
          Effect.gen(function* () {
            yield* claims.releaseAllForOrganization(orgOf(row, as));
            const outcome = yield* claim(`${row.organizationId}-third`, `third-${row.id}`, [
              row.domain,
            ]).pipe(Effect.exit);
            return outcome._tag === "Success";
          }),
        ),
    },
  },
};

TestAuth.runTenantIsolationTests(vitestFramework, {
  plugin: Organization.Organization,
  covers: ["organization_domain_owner", "organization_domain_claim"],
  adapters: [
    { name: "layerMemory", layer: MemoryLayer },
    { name: "layerSql", layer: SqlLayer },
  ],
  cases: [
    { table: "organization_domain_owner", insert: isolationInsert, methods: isolationMethods },
    { table: "organization_domain_claim", insert: isolationInsert, methods: isolationMethods },
  ],
  rls: { layer: SqlLayer },
});
