// BEH-EA-317 (plan 10 item 7): upgrading a database that already holds domain claims. The organization migration
// backfills the OIDC domains into `organization_domain_claim`; Saml's own backfills its domains after it, and
// REFUSES (naming the domains) when one organization holds a domain over OIDC that another holds over SAML:
// which side keeps it is the operator's call.
import { Auth, Migrations } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { TestSql } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Saml from "../src/Saml.ts";

const all = Auth.make([Organization.Organization, Saml.Saml]).migrations;

const named = (suffix: string) => {
  const found = all.find((migration) => migration.name.endsWith(suffix));
  if (found === undefined) throw new Error(`no migration ${suffix}`);
  return found;
};
const organizationClaims = named("create_organization_domain_claim");
const samlBackfill = named("claim_saml_connection_domains");

/** Every migration but the two this release adds: the database as it was before it. */
const before = all.filter(
  (migration) => migration !== organizationClaims && migration !== samlBackfill,
);

const seed = (rows: {
  readonly oauth: ReadonlyArray<readonly [domain: string, org: string]>;
  readonly saml: ReadonlyArray<readonly [domain: string, org: string]>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrations.run(before);
    for (const [index, [domain, org]] of rows.oauth.entries()) {
      yield* sql`INSERT INTO organization_oauth_connection_domain (domain, "connectionId", "organizationId") VALUES (${domain}, ${`oidc-${index}`}, ${org})`;
    }
    for (const [index, [domain, org]] of rows.saml.entries()) {
      yield* sql`INSERT INTO saml_connection (id, "organizationId", name, "idpEntityId", "ssoUrl", "idpCertificates", "createdAt", "updatedAt") VALUES (${`saml-${index}`}, ${org}, 'x', 'e', 'https://idp.example.com', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO saml_connection_domain (domain, "connectionId") VALUES (${domain}, ${`saml-${index}`})`;
    }
  });

const claims = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly domain: string;
    readonly protocol: string;
    readonly organizationId: string;
  }>`SELECT domain, protocol, "organizationId" FROM organization_domain_claim ORDER BY domain, protocol`;
  const owners = yield* sql<{
    readonly domain: string;
  }>`SELECT domain FROM organization_domain_owner ORDER BY domain`;
  return { rows, owners: owners.map((row) => row.domain) };
});

describe("the domain-claim backfill", () => {
  it.effect("claims every stored OIDC and SAML domain for its organization", () =>
    Effect.gen(function* () {
      yield* seed({
        oauth: [["acme.example", "org-1"]],
        saml: [
          ["acme.example", "org-1"],
          ["other.example", "org-2"],
        ],
      });
      yield* Migrations.run([organizationClaims], { table: "upgrade_organization" });
      yield* Migrations.run([samlBackfill], { table: "upgrade_saml" });
      const { rows, owners } = yield* claims;
      assert.deepStrictEqual(
        rows.map((row) => [row.domain, row.protocol, row.organizationId]),
        [
          ["acme.example", "oauth", "org-1"],
          ["acme.example", "saml", "org-1"],
          ["other.example", "saml", "org-2"],
        ],
      );
      assert.deepStrictEqual(owners, ["acme.example", "other.example"]);
    }).pipe(Effect.provide(TestSql.layer("saml_DomainClaimBackfill"))),
  );

  it.effect(
    "fails, naming the domain, when two organizations hold it over different protocols",
    () =>
      Effect.gen(function* () {
        yield* seed({
          oauth: [["acme.example", "org-1"]],
          saml: [["acme.example", "org-2"]],
        });
        yield* Migrations.run([organizationClaims], { table: "upgrade_organization" });
        const outcome = yield* Effect.exit(
          Migrations.run([samlBackfill], { table: "upgrade_saml" }),
        );
        assert.isTrue(Exit.isFailure(outcome));
        assert.include(String(outcome), "acme.example");
        assert.include(String(outcome), "BEH-EA-317");
        // Nothing was claimed: the failed migration rolled back.
        assert.deepStrictEqual(
          (yield* claims).rows.map((row) => row.protocol),
          ["oauth"],
        );
      }).pipe(Effect.provide(TestSql.layer("saml_DomainClaimClash"))),
  );
});
