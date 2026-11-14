// Phase 6 Wave 0 oracle (REC-03): the equal-createdAt order of the SCIM listings the comparator helper rewrites
// (ScimRecords.listConnections, list and linksOfResource), on both adapters. Expected orders are literals over
// canonical ids. Never edited after its add commit.
import { Auth } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { TenantScoped } from "@awthaq/sql";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Scim from "../src/Scim.ts";
import * as ScimRecords from "../src/ScimRecords.ts";
import { groupsTeams } from "./support.ts";

const X = "019a8f00-0000-7000-8000-000000000009";
const A = "019a8f00-0000-7000-8000-000000000001";
const B = "019a8f00-0000-7000-8000-000000000002";
const C = "019a8f00-0000-7000-8000-000000000003";

const grant = TenantScoped.crossTenant("scim order pins: a cross-organization caller");

const connection = (id: string, organizationId: string) => ({
  id,
  organizationId,
  name: `Directory ${id}`,
  tokenHash: `hash-${id}`,
});

const built = Auth.make([Organization.Organization, Scim.Scim]);
const services = Layer.mergeAll(Scim.config({}), Organization.config({ teams: groupsTeams }));

const compositions = {
  memory: TestAuth.layer(built, { services }),
  sql: TestAuth.layer(built, { records: "sql", suite: "scim_RecordOrderPins", services }),
};

for (const [mode, Live] of Object.entries(compositions)) {
  describe(`scim record order pins (${mode})`, () => {
    it.effect("ScimRecords.listConnections: time first, then id, ascending", () =>
      Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        yield* records.createConnection(connection(X, "org-pin"));
        yield* TestClock.adjust("1 millis");
        yield* records.createConnection(connection(C, "org-pin"));
        yield* records.createConnection(connection(A, "org-pin"));
        yield* records.createConnection(connection(B, "org-pin"));
        yield* records.createConnection(
          connection("019a8f00-0000-7000-8000-000000000007", "org-other"),
        );
        const listed = yield* records.listConnections("org-pin");
        assert.deepStrictEqual(
          listed.map((row) => row.id),
          [X, A, B, C],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("ScimRecords.list orders a connection's links by (createdAt, resourceId)", () =>
      Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        yield* records.createConnection(connection("c-pin", "org-pin"));
        yield* records.createConnection(connection("c-other", "org-pin"));
        yield* records.link({ connectionId: "c-pin", kind: "User", resourceId: X, name: "x" });
        yield* TestClock.adjust("1 millis");
        yield* records.link({ connectionId: "c-pin", kind: "User", resourceId: C, name: "c" });
        yield* records.link({ connectionId: "c-pin", kind: "User", resourceId: A, name: "a" });
        yield* records.link({ connectionId: "c-pin", kind: "User", resourceId: B, name: "b" });
        yield* records.link({
          connectionId: "c-other",
          kind: "User",
          resourceId: "019a8f00-0000-7000-8000-000000000007",
          name: "other",
        });
        const page = yield* records.list("c-pin", "User", { offset: 0, limit: 10 });
        assert.deepStrictEqual(
          page.items.map((row) => row.resourceId),
          [X, A, B, C],
        );
        assert.strictEqual(page.total, 4);
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("ScimRecords.linksOfResource orders by (createdAt, connectionId)", () =>
      Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        for (const id of [X, C, A, B]) {
          yield* records.createConnection(connection(id, "org-pin"));
        }
        const link = (connectionId: string) =>
          records.link({ connectionId, kind: "User", resourceId: "user-pin", name: "pin" });
        yield* link(X);
        yield* TestClock.adjust("1 millis");
        yield* link(C);
        yield* link(A);
        yield* link(B);
        const links = yield* records.linksOfResource(grant, "User", "user-pin");
        assert.deepStrictEqual(
          links.map((row) => row.connectionId),
          [X, A, B, C],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );
  });
}
