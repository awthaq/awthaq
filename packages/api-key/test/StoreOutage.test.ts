// Plan 05 (ADR-EA-028): an `ApiKeyRecords` store outage is the typed `StoreUnavailable`, never a defect —
// so the credential resolver can answer 503 instead of a 500, and a retry can succeed.
import { Migrations, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import * as ApiKey from "../src/ApiKey.ts";
import * as ApiKeyRecords from "../src/ApiKeyRecords.ts";

const SqlLive = TestSql.layer("api_key_StoreOutage");
const Migrated = Layer.effectDiscard(Migrations.run(ApiKey.ApiKey.migrations)).pipe(
  Layer.provide(SqlLive),
);
const SqlLayer = ApiKeyRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

describe("ApiKeyRecords.layerSql: a store outage", () => {
  it.effect("insert fails with StoreUnavailable naming the operation", () =>
    Effect.gen(function* () {
      yield* TestSql.injectFailure({
        name: "apikey_fail_insert",
        table: "apikey_key",
        event: "INSERT",
      });
      const records = yield* ApiKeyRecords.ApiKeyRecords;
      const failure = yield* records
        .insert({
          id: "k1",
          ownerId: Users.UserId("owner-1"),
          name: "outage",
          start: "abc",
          secretHash: "hash",
          scopes: [],
          createdAt: yield* DateTime.now,
          expiresAt: Option.none(),
          revokedAt: Option.none(),
          lastUsedAt: Option.none(),
          rotatedFrom: Option.none(),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(Effect.provide(SqlLayer)),
  );
});
