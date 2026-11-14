// FINDING, not a fix (phase 4 CONN-06, deferred to CONN-F1; see
// .planning/phases/04-connection-lifecycle-module/04-FINDINGS.md): a SCIM connection created for an organization
// that does not exist is stored, and an organization deletion can never clean it up. This test characterizes today's
// behaviour; it is expected to flip when CONN-F1 makes `ScimConnectionStore.create` check the organization.
import { OrganizationDirectory } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ScimConnections from "../src/ScimConnections.ts";
import { ScimLive } from "./support.ts";

describe("SCIM connection for an unknown organization (finding F-04-01, CONN-F1)", () => {
  it.effect("is stored and listed although the organization does not exist", () =>
    Effect.gen(function* () {
      const store = yield* ScimConnections.ScimConnectionStore;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const { connection } = yield* store.create({
        organizationId: "no-such-organization",
        name: "orphan",
      });
      assert.strictEqual(connection.organizationId, "no-such-organization");
      assert.deepStrictEqual(
        (yield* store.list("no-such-organization")).map((row) => row.id),
        [connection.id],
      );
      assert.isTrue(Option.isNone(yield* directory.findActive("no-such-organization")));
    }).pipe(Effect.provide(ScimLive())),
  );
});
