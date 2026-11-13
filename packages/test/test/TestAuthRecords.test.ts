// BEH-EA-T2: `TestAuth.layer` runs the same composition over memory and over SQL. A fixture plugin (`Pins`) owns
// one table and a matched records bundle; the same assertions hold in both modes, and in SQL mode the row is
// really in the migrated database (and, under `pnpm test:pg`, in a per-suite Postgres schema).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Auth } from "@awthaq/core";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestAuth from "../src/TestAuth.ts";
import { PinRecords, Pins } from "./support/Pins.ts";

const built = Auth.make([Pins]);

const roundTrip = async (app: {
  readonly signIn: (email: string) => Promise<TestAuth.SignedInAgent>;
}) => {
  const pinner = await app.signIn("pins@example.com");
  const added = await pinner.request("POST", "/pins", {
    json: { label: "first" },
  });
  const listed = await pinner.request("GET", "/pins");
  return { added: added.status, listed: await listed.json() };
};

describe("TestAuth.layer records modes (BEH-EA-T2)", () => {
  it("memory: the plugin's own records bundle serves the request", async () => {
    await TestAuth.withApp(TestAuth.layer(built), undefined, async (app) => {
      const seen = await roundTrip(app);
      assert.strictEqual(seen.added, 200);
      assert.deepStrictEqual(seen.listed, ["first"]);
      assert.deepStrictEqual(await app.run(Effect.flatMap(PinRecords, (pins) => pins.list)), [
        "first",
      ]);
    });
  });

  it("sql: the same composition over a migrated database, and the row is really in it", async () => {
    await TestAuth.withApp(
      TestAuth.layer(built, {
        records: "sql",
        suite: "test_auth_records_roundtrip",
      }),
      undefined,
      async (app) => {
        const seen = await roundTrip(app);
        assert.strictEqual(seen.added, 200);
        assert.deepStrictEqual(seen.listed, ["first"]);
        const rows = await app.run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql<{ readonly label: string }>`SELECT label FROM pins_pin`,
          ),
        );
        assert.deepStrictEqual(
          rows.map((row) => row.label),
          ["first"],
        );
      },
    );
  });

  it("sql: two suites never share rows", async () => {
    await TestAuth.withApp(
      TestAuth.layer(built, { records: "sql", suite: "test_auth_records_a" }),
      undefined,
      (first) =>
        TestAuth.withApp(
          TestAuth.layer(built, {
            records: "sql",
            suite: "test_auth_records_b",
          }),
          undefined,
          async (second) => {
            await first.run(Effect.flatMap(PinRecords, (pins) => pins.add("only-in-a")));
            assert.deepStrictEqual(
              await second.run(Effect.flatMap(PinRecords, (pins) => pins.list)),
              [],
            );
            assert.deepStrictEqual(
              await first.run(Effect.flatMap(PinRecords, (pins) => pins.list)),
              ["only-in-a"],
            );
          },
        ),
    );
  });
});
