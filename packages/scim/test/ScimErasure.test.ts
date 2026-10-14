// ADR-EA-031/CSG-001/CSG-005: `Scim.scimErasure` and `Scim.scimExport`, the plugin's part of
// `AccountErasure.eraseAccount` and of the data-subject export. The contribution runs for every
// initiator, so a self-service or administrator erasure also drops the directory's mapping (its
// `userName`, usually the email).
import { DataExport, Erasure, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scim from "../src/Scim.ts";
import * as ScimRecords from "../src/ScimRecords.ts";
import { ScimLive, seedConnection } from "./support.ts";

describe("SCIM erasure and export contributions (ADR-EA-031)", () => {
  it.effect("a self-service erasure removes the user's SCIM mapping", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const records = yield* ScimRecords.ScimRecords;
      const erasure = yield* Erasure.AccountErasure;
      const created = yield* scim.createUser(connection, {
        userName: "ada@acme.example",
        externalId: "dir-1",
      });
      const other = yield* scim.createUser(connection, { userName: "bo@acme.example" });
      assert.isTrue(Option.isSome(yield* records.find(connection.id, "User", created.id)));

      yield* erasure.eraseAccount(Users.UserId(created.id), Erasure.ErasureInitiator.Self());

      assert.isTrue(Option.isNone(yield* records.find(connection.id, "User", created.id)));
      assert.isTrue(Option.isSome(yield* records.find(connection.id, "User", other.id)));
      // The directory's userName and externalId are free again.
      const again = yield* scim.createUser(connection, {
        userName: "ada@acme.example",
        externalId: "dir-1",
      });
      assert.notStrictEqual(again.id, created.id);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "the SCIM export lists the connection, userName and externalId and nothing secret",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const registry = yield* DataExport.DataExportRegistry;
        const created = yield* scim.createUser(connection, {
          userName: "ada@acme.example",
          externalId: "dir-1",
        });
        const contribution = (yield* registry.contributions).find((entry) => entry.id === "scim");
        assert.isDefined(contribution);
        const section = yield* (
          contribution?.collect({
            userId: Users.UserId(created.id),
            email: "ada@acme.example",
          }) ?? Effect.die("the scim export contribution is not registered")
        );
        const text = JSON.stringify(section);
        assert.include(text, connection.id);
        assert.include(text, "ada@acme.example");
        assert.include(text, "dir-1");
        assert.isFalse(JSON.stringify(section).includes("tokenHash"));
      }).pipe(Effect.provide(ScimLive())),
  );
});
