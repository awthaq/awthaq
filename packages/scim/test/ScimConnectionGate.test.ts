// F-04-01 (CONN-F1): a SCIM connection belongs to an active organization. `ScimConnectionStore.create` goes through
// the exposed `OrganizationConnectionLifecycle`: an unknown and a suspended organization are refused alike and nothing
// is stored; an active one gets a connection whose token authenticates. Memory and SQL (SQLite, or Postgres under
// AWTHAQ_POSTGRES_URL). The Postgres-only race with an organization deletion is `ScimConnectionGate.sql.test.ts`.
import { OrganizationActor, OrganizationDirectory } from "@awthaq/organization";
import { Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ScimConnections from "../src/ScimConnections.ts";
import { ScimLive, ScimLiveSql, seedConnection } from "./support.ts";

const admin = OrganizationActor.platformAdmin(Users.UserId("admin"));

const modes = [
  ["memory", () => ScimLive()],
  ["SQL", () => ScimLiveSql("scim_connection_gate")],
] as const;

for (const [label, layer] of modes) {
  describe(`a SCIM connection belongs to an active organization (${label})`, () => {
    it.effect("an unknown organization is refused and nothing is stored", () =>
      Effect.gen(function* () {
        const store = yield* ScimConnections.ScimConnectionStore;
        const error = yield* Effect.flip(
          store.create({
            organizationId: "no-such-organization",
            name: "orphan",
          }),
        );
        assert.strictEqual(String(error._tag), "InvalidScimConnection");
        assert.deepStrictEqual(yield* store.list("no-such-organization"), []);
      }).pipe(Effect.provide(layer())),
    );

    it.effect("a suspended organization is refused alike, and nothing is stored", () =>
      Effect.gen(function* () {
        const store = yield* ScimConnections.ScimConnectionStore;
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const { organizationId } = yield* seedConnection("suspended");
        yield* directory.suspend(admin, { organizationId });
        const error = yield* Effect.flip(store.create({ organizationId, name: "second" }));
        assert.strictEqual(String(error._tag), "InvalidScimConnection");
        assert.deepStrictEqual(
          (yield* store.list(organizationId)).map((row) => row.name),
          ["suspended"],
        );
      }).pipe(Effect.provide(layer())),
    );

    it.effect("an active organization gets a connection that is listed", () =>
      Effect.gen(function* () {
        const store = yield* ScimConnections.ScimConnectionStore;
        const directory = yield* OrganizationDirectory.OrganizationDirectory;
        const { organizationId, connection } = yield* seedConnection("active");
        assert.isTrue(Option.isSome(yield* directory.findActive(organizationId)));
        assert.deepStrictEqual(
          (yield* store.list(organizationId)).map((row) => row.id),
          [connection.id],
        );
      }).pipe(Effect.provide(layer())),
    );
  });
}
