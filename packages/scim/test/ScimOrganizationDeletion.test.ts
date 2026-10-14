// Plan 04 (F7): deleting an organization removes its SCIM connections and their mappings, in the
// deletion's own transaction. Before, `scim_connection` and `scim_resource` rows outlived the organization.
import { OrganizationActor, OrganizationDirectory } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scim from "../src/Scim.ts";
import * as ScimRecords from "../src/ScimRecords.ts";
import { ScimLive, seedConnection } from "./support.ts";

describe("SCIM connections go with their organization (plan 04, F7)", () => {
  it.effect(
    "deleting the organization removes its connections, users' links and groups' links",
    () =>
      Effect.gen(function* () {
        const kept = yield* seedConnection("Entra");
        const doomed = yield* seedConnection("Okta");
        const scim = yield* Scim.Scim;
        const records = yield* ScimRecords.ScimRecords;
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const user = yield* scim.createUser(doomed.connection, { userName: "ada@acme.example" });
        const group = yield* scim.createGroup(doomed.connection, { displayName: "Eng" });
        yield* scim.createUser(kept.connection, { userName: "bo@acme.example" });

        yield* directory.delete(OrganizationActor.application("test"), {
          organizationId: doomed.organizationId,
        });

        assert.deepStrictEqual(yield* records.listConnections(doomed.organizationId), []);
        assert.isTrue(Option.isNone(yield* records.find(doomed.connection.id, "User", user.id)));
        assert.isTrue(Option.isNone(yield* records.find(doomed.connection.id, "Group", group.id)));
        // Another organization's directory is untouched.
        assert.strictEqual((yield* records.listConnections(kept.organizationId)).length, 1);
        assert.strictEqual((yield* scim.listUsers(kept.connection, {})).totalResults, 1);
      }).pipe(Effect.provide(ScimLive())),
  );
});
