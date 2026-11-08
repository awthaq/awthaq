// Plan 25 ticket 14 (ADR-EA-041 decision 9): `DomainClaims`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. A domain belongs to one organization (BEH-EA-317): of organizations
// racing to claim it, exactly one wins.
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DomainClaims from "../../src/DomainClaims.ts";
import { ambientOrganization } from "../support.ts";
import { RecordsContract, type TestAuth } from "@awthaq/test";

const claim = (
  organizationId: string,
  connectionId: string,
  domains: ReadonlyArray<string>,
  protocol = "oauth",
) =>
  Effect.flatMap(DomainClaims.DomainClaims, (claims) =>
    claims.claim({ organizationId, protocol, connectionId, domains }),
  );

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

export const domainClaims = RecordsContract.suite(DomainClaims.DomainClaims, {
  operations: {
    claim: {
      atomic: [
        {
          name: "another organization cannot claim a domain, over any protocol, and nothing changes",
          run: Effect.gen(function* () {
            yield* claim("org-1", "c1", ["acme.example"], "oauth");
            const clash = yield* claim(
              "org-2",
              "c2",
              ["free.example", "acme.example"],
              "saml",
            ).pipe(Effect.flip);
            assert.strictEqual(clash._tag, "DomainClaimTaken");
            assert.strictEqual(
              clash._tag === "DomainClaimTaken" ? clash.domain : "",
              "acme.example",
            );
            // The refused claim took nothing, not even the domain listed before the clash.
            yield* claim("org-3", "c3", ["free.example"], "saml");
          }),
        },

        {
          name: "the owner may route a domain over both protocols and several connections",
          run: Effect.gen(function* () {
            yield* claim("org-1", "c1", ["acme.example"], "oauth");
            yield* claim("org-1", "c2", ["acme.example", "acme.test"], "saml");
            // Re-asserting the same set is idempotent.
            yield* claim("org-1", "c2", ["acme.example", "acme.test"], "saml");
            const other = yield* claim("org-2", "c3", ["acme.test"], "oauth").pipe(Effect.flip);
            assert.strictEqual(other._tag, "DomainClaimTaken");
          }),
        },

        {
          name: "claiming a smaller set releases the domains dropped, and only those",
          run: Effect.gen(function* () {
            yield* claim("org-1", "c1", ["a.example", "b.example"]);
            yield* claim("org-1", "c1", ["a.example"]);
            yield* claim("org-2", "c2", ["b.example"]);
            assert.strictEqual(
              (yield* claim("org-2", "c3", ["a.example"]).pipe(Effect.flip))._tag,
              "DomainClaimTaken",
            );
          }),
        },
      ],
      race: [
        {
          name: "8 organizations racing to claim one domain: exactly one owns it",
          run: Effect.gen(function* () {
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.exit(claim(`org-${n}`, `c-${n}`, ["contested.example"])),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
          }),
        },
      ],
    },
    release: {
      write: [
        {
          name: "a domain is released only when its last claiming connection lets go",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    releaseAllForOrganization: {
      write: [
        {
          name: "releasing an organization frees every domain it owned, and no other's",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
  },
  tenancy: {
    covers: ["organization_domain_owner", "organization_domain_claim"],
    cases: [
      { table: "organization_domain_owner", insert: isolationInsert, methods: isolationMethods },
      { table: "organization_domain_claim", insert: isolationInsert, methods: isolationMethods },
    ],
  },
});
