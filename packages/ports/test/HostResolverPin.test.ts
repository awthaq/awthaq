// BEH-EA-303: `HostResolver.pin` resolves once and returns THE address to connect to; a caller that connects
// there (with the URL's own host as Host/SNI) never resolves the name again, which is what closes DNS rebinding.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HostResolver from "../src/HostResolver.ts";

const withTable = (table: Record<string, ReadonlyArray<string>>) =>
  Effect.provide(HostResolver.layerStatic(table));

describe("HostResolver.pin", () => {
  it.effect("returns the first public answer with the URL's own host name", () =>
    Effect.gen(function* () {
      const pinned = yield* HostResolver.pin("https://Hooks.Example.com:8443/x");
      assert.deepStrictEqual(
        pinned,
        Result.succeed({ hostname: "hooks.example.com", address: "93.184.216.34", family: 4 }),
      );
    }).pipe(withTable({ "hooks.example.com": ["93.184.216.34", "2606:2800:220:1::1"] })),
  );

  it.effect("pins an IPv6 answer as family 6", () =>
    Effect.gen(function* () {
      const pinned = yield* HostResolver.pin("https://v6.example.com/x");
      assert.strictEqual(pinned._tag === "Success" ? pinned.success.family : 0, 6);
    }).pipe(withTable({ "v6.example.com": ["2606:2800:220:1::1"] })),
  );

  it.effect("asks the resolver exactly once per pin", () =>
    Effect.gen(function* () {
      let lookups = 0;
      yield* HostResolver.pin("https://hooks.example.com/x").pipe(
        Effect.provideService(
          HostResolver.HostResolver,
          HostResolver.HostResolver.of({
            resolve: () => {
              lookups += 1;
              return Effect.succeed(["93.184.216.34"]);
            },
          }),
        ),
      );
      assert.strictEqual(lookups, 1);
    }),
  );

  it.effect(
    "refuses when any answer is private, when nothing resolves, and for a private literal",
    () =>
      Effect.gen(function* () {
        for (const url of [
          "https://mixed.example.com/x",
          "https://nx.example.com/x",
          "https://10.0.0.1/x",
          "https://[::1]/x",
          "not a url",
        ]) {
          assert.strictEqual((yield* HostResolver.pin(url))._tag, "Failure", url);
        }
      }).pipe(withTable({ "mixed.example.com": ["93.184.216.34", "10.0.0.7"] })),
  );

  it.effect("judges an IP literal as written and pins it without a lookup", () =>
    Effect.gen(function* () {
      const pinned = yield* HostResolver.pin("https://93.184.216.34/x");
      assert.deepStrictEqual(
        pinned,
        Result.succeed({ hostname: "93.184.216.34", address: "93.184.216.34", family: 4 }),
      );
    }).pipe(withTable({})),
  );
});
