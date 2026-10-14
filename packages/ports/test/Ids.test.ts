// Plan 02, phase 1: the identifier brands now live at the ports stratum; `@awthaq/sql`'s
// `Models` re-exports the very same schemas (MA-008: one brand per id).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Ids from "../src/Ids.ts";
import * as Tenant from "../src/Tenant.ts";

describe("Ids", () => {
  it("E164 accepts an international number and refuses a bare or zero-led one", () => {
    const decode = Schema.decodeUnknownOption(Ids.E164);
    assert.isTrue(Option.isSome(decode("+14155550100")));
    assert.isTrue(Option.isNone(decode("14155550100")));
    assert.isTrue(Option.isNone(decode("+0123456789")));
  });
});

describe("Tenant.resolve", () => {
  it.effect("an explicit tenant wins over the ambient one", () =>
    Effect.gen(function* () {
      const resolved = yield* Tenant.resolve(Option.some("explicit"));
      assert.deepStrictEqual(resolved, Option.some("explicit"));
    }).pipe(Tenant.withTenant("ambient")),
  );

  it.effect("with none explicit, the ambient tenant, else none", () =>
    Effect.gen(function* () {
      const ambient = yield* Tenant.resolve(Option.none()).pipe(Tenant.withTenant("ambient"));
      assert.deepStrictEqual(ambient, Option.some("ambient"));
      const none = yield* Tenant.resolve(Option.none());
      assert.deepStrictEqual(none, Option.none());
    }),
  );
});
