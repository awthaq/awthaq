// Plan 05 (ADR-EA-028): a `DeviceGrantRecords` store outage is the typed `StoreUnavailable`, never a defect —
// the device's poll then reads a 503 it can retry, not a 500.
import { Migrations } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestSql } from "@awthaq/test";
import * as DeviceAuthorization from "../src/DeviceAuthorization.ts";
import * as DeviceGrantRecords from "../src/DeviceGrantRecords.ts";

const SqlLive = TestSql.layer("device_authorization_StoreOutage");
const Migrated = Layer.effectDiscard(
  Migrations.run(DeviceAuthorization.DeviceAuthorization.migrations),
).pipe(Layer.provide(SqlLive));
const SqlLayer = DeviceGrantRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

describe("DeviceGrantRecords.layerSql: a store outage", () => {
  it.effect("insert fails with StoreUnavailable naming the operation", () =>
    Effect.gen(function* () {
      yield* TestSql.injectFailure({
        name: "device_grant_fail_insert",
        table: "device_authorization_grant",
        event: "INSERT",
      });
      const records = yield* DeviceGrantRecords.DeviceGrantRecords;
      const now = yield* DateTime.now;
      const failure = yield* records
        .insert({
          id: "g1",
          deviceCodeHash: "device-hash",
          userCodeHash: "user-hash",
          clientId: "client-1",
          scopes: [],
          status: "pending",
          userId: Option.none(),
          amr: [],
          pollInterval: 5,
          createdAt: now,
          expiresAt: DateTime.addDuration(now, Duration.minutes(10)),
          lastPolledAt: Option.none(),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(Effect.provide(SqlLayer)),
  );
});
