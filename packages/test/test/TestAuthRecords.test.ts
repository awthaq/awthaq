// BEH-EA-T2: `TestAuth.layer` runs the same composition over memory and over SQL. A fixture plugin (`Pins`) owns
// one table and a matched records bundle; the same assertions hold in both modes, and in SQL mode the row is
// really in the migrated database (and, under `pnpm test:pg`, in a per-suite Postgres schema).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Auth } from "@awthaq/core";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestAuth from "../src/TestAuth.ts";
import { PinRecords, Pins } from "./support/Pins.ts";

const built = Auth.make([Pins]);

const roundTrip = async (app: {
  readonly signIn: (email: string) => Promise<TestAuth.SignedInSession>;
  readonly request: (
    method: string,
    path: string,
    init?: TestAuth.RequestInit,
  ) => Promise<Response>;
}) => {
  const signedIn = await app.signIn("pins@example.com");
  const added = await app.request("POST", "/pins", {
    cookie: signedIn.cookieHeader,
    json: { label: "first" },
  });
  const listed = await app.request("GET", "/pins", { cookie: signedIn.cookieHeader });
  return { added: added.status, listed: await listed.json() };
};

describe("TestAuth.layer records modes (BEH-EA-T2)", () => {
  it("memory: the plugin's own records bundle serves the request", async () => {
    const app = TestAuth.app(TestAuth.layer(built));
    try {
      const seen = await roundTrip(app);
      assert.strictEqual(seen.added, 200);
      assert.deepStrictEqual(seen.listed, ["first"]);
      assert.deepStrictEqual(await app.run(Effect.flatMap(PinRecords, (pins) => pins.list)), [
        "first",
      ]);
    } finally {
      await app.dispose();
    }
  });

  it("sql: the same composition over a migrated database, and the row is really in it", async () => {
    const app = TestAuth.app(
      TestAuth.layer(built, { records: "sql", suite: "test_auth_records_roundtrip" }),
    );
    try {
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
    } finally {
      await app.dispose();
    }
  });

  it("sql: two suites never share rows", async () => {
    const first = TestAuth.app(
      TestAuth.layer(built, { records: "sql", suite: "test_auth_records_a" }),
    );
    const second = TestAuth.app(
      TestAuth.layer(built, { records: "sql", suite: "test_auth_records_b" }),
    );
    try {
      await first.run(Effect.flatMap(PinRecords, (pins) => pins.add("only-in-a")));
      assert.deepStrictEqual(await second.run(Effect.flatMap(PinRecords, (pins) => pins.list)), []);
      assert.deepStrictEqual(await first.run(Effect.flatMap(PinRecords, (pins) => pins.list)), [
        "only-in-a",
      ]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
