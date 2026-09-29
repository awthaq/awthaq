// BEH-EA-009 (composition), plugin conventions (docs/plugin-authoring.md): `Auth.make`
// composes `ApiKey` with the `Jwt` it depends on and a malformed prefix is a boot defect. (The
// real migrations are exercised by every `sql` suite in this package, which migrates with
// `ApiKey.migrations` and then runs the whole lifecycle against the result.)
import { Auth } from "@awthaq/core";
import { Jwt } from "@awthaq/jwt";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as ApiKey from "../src/ApiKey.ts";
import { buildLayer } from "./harness.ts";

describe("ApiKey plugin", () => {
  it("composes through Auth.make beside Jwt, with its tables in the manifest and Jwt as a dependency", () => {
    const auth = Auth.make([Jwt.Jwt, ApiKey.ApiKey]);
    assert.strictEqual(auth.api.identifier, "auth");
    const entry = auth.manifest.plugins.find((plugin) => plugin.id === "apikey");
    assert.deepStrictEqual(entry?.tables, ["apikey_key", "apikey_client"]);
    assert.deepStrictEqual(entry?.dependsOn, ["jwt"]);
  });

  it("refuses to compose without the Jwt it mints service tokens through", () => {
    // @ts-expect-error a missing dependency is a compile-time error naming `jwt` (BEH-EA-009).
    Auth.make([ApiKey.ApiKey]);
  });

  it("declares one group per surface: management, clients, token endpoint", () => {
    assert.deepStrictEqual(Object.keys(ApiKey.ApiKey.contract.groups).sort(), [
      "apikey",
      "apikey.client",
      "apikey.token",
    ]);
  });

  it.effect("a prefix containing a dot (which would break the key format) fails at build", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.void.pipe(
          Effect.provide(buildLayer({ store: "memory", config: { prefix: "ak." } })),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it("parseKey splits prefix, id and secret and rejects everything else", () => {
    const parse = (raw: string) => ApiKey.parseKey(raw, "ak_");
    assert.deepStrictEqual(parse("ak_id-1.secret"), Option.some({ id: "id-1", secret: "secret" }));
    // The first dot splits: a secret may not be empty, an id may not be.
    assert.deepStrictEqual(parse("ak_id.se.cret"), Option.some({ id: "id", secret: "se.cret" }));
    for (const bad of [
      "",
      "ak_",
      "ak_.",
      "ak_id",
      "ak_id.",
      "ak_.secret",
      "xx_id.secret",
      "x".repeat(600),
    ]) {
      assert.isTrue(Option.isNone(parse(bad)), bad);
    }
  });
});
