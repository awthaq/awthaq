// Phase 6 Wave 0 oracle (REC-03): the equal-createdAt order of the organization listings the comparator helper
// rewrites (ConnectionRecords.listByOrganization, TeamRecords.getDescendants and getSubtree), on both adapters.
// Expected orders are literals over canonical ids (or the store's minted ids sorted by code unit, no comparator).
// Never edited after its add commit.
import { Auth } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionRecords from "../src/ConnectionRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

const X = "019a8f00-0000-7000-8000-000000000009";
const A = "019a8f00-0000-7000-8000-000000000001";
const B = "019a8f00-0000-7000-8000-000000000002";
const C = "019a8f00-0000-7000-8000-000000000003";

const connection = (
  id: string,
  organizationId: string,
  domain: string,
): ConnectionRecords.ConnectionInput => ({
  id,
  organizationId,
  kind: "oidc",
  name: "Acme SSO",
  issuer: "https://idp.acme.example",
  discoveryUrl: "https://idp.acme.example/.well-known/openid-configuration",
  clientId: "client-1",
  clientSecret: Redacted.make("provider-secret"),
  scopes: ["openid", "email"],
  emailDomains: [domain],
});

const compositions = {
  memory: TestAuth.layer(Auth.make([Organization.Organization]), {
    services: Organization.config({}),
  }),
  sql: TestAuth.layer(Auth.make([Organization.Organization]), {
    records: "sql",
    suite: "organization_RecordOrderPins",
    services: Organization.config({}),
  }),
};

for (const [mode, Live] of Object.entries(compositions)) {
  describe(`organization record order pins (${mode})`, () => {
    it.effect("ConnectionRecords.listByOrganization: time first, then id, ascending", () =>
      Effect.gen(function* () {
        const records = yield* ConnectionRecords.ConnectionRecords;
        yield* records.create(connection(X, "org-pin", "x.example"));
        yield* TestClock.adjust("1 millis");
        yield* records.create(connection(C, "org-pin", "c.example"));
        yield* records.create(connection(A, "org-pin", "a.example"));
        yield* records.create(connection(B, "org-pin", "b.example"));
        yield* records.create(
          connection("019a8f00-0000-7000-8000-000000000007", "org-other", "other.example"),
        );
        const listed = yield* records.listByOrganization("org-pin");
        assert.deepStrictEqual(
          listed.map((row) => row.id),
          [X, A, B, C],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    // A root, three children at one instant, two grandchildren (under different children) at a later one.
    const tree = Effect.gen(function* () {
      const records = yield* TeamRecords.TeamRecords;
      const org = "org-pin";
      const root = yield* records.createTeam({ organizationId: org, name: "root" });
      yield* TestClock.adjust("1 millis");
      const children = [
        yield* records.createTeam({ organizationId: org, name: "c1", parentId: root.id }),
        yield* records.createTeam({ organizationId: org, name: "c2", parentId: root.id }),
        yield* records.createTeam({ organizationId: org, name: "c3", parentId: root.id }),
      ];
      yield* TestClock.adjust("1 millis");
      const grandchildren = [
        yield* records.createTeam({ organizationId: org, name: "g1", parentId: children[2]!.id }),
        yield* records.createTeam({ organizationId: org, name: "g2", parentId: children[0]!.id }),
      ];
      const expectedBelow = [
        ...children.map((row) => row.id).sort(),
        ...grandchildren.map((row) => row.id).sort(),
      ];
      return { records, org, root, expectedBelow };
    });

    it.effect("TeamRecords.getDescendants: depth first, then (createdAt, id) within a level", () =>
      Effect.gen(function* () {
        const { records, org, root, expectedBelow } = yield* tree;
        const below = yield* records.getDescendants(org, root.id);
        assert.deepStrictEqual(
          below.map((row) => row.id),
          expectedBelow,
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("TeamRecords.getSubtree: the team, then its descendants in that order", () =>
      Effect.gen(function* () {
        const { records, org, root, expectedBelow } = yield* tree;
        const subtree = yield* records.getSubtree(org, root.id);
        assert.deepStrictEqual(
          subtree.map((row) => row.id),
          [root.id, ...expectedBelow],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );
  });
}
