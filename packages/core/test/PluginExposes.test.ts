// ADR-EA-040: a plugin may expose namespaced domain services (`AuthPlugin.layer`'s `exposes`) beside its
// own service. They join the layer's `ROut`, `Auth.make`'s fold discharges a dependent's requirement on
// them, and `Validate` refuses a dependent that does not list the exposer in `dependsOn`. The type-level
// halves are `@ts-expect-error` directives, checked by `tsc -p tsconfig.test.json`.
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";

class Vault extends Context.Service<Vault, { readonly secret: Effect.Effect<string> }>()(
  "awthaq/plugin/bank/Vault",
) {}

class Ledger extends Context.Service<Ledger, { readonly total: Effect.Effect<number> }>()(
  "awthaq/plugin/bank/Ledger",
) {}

/** Keyed outside the exposer's namespace. */
class Stray extends Context.Service<Stray, {}>()("awthaq/plugin/elsewhere/Stray") {}

const VaultLive = Layer.succeed(Vault, { secret: Effect.succeed("swordfish") });
const LedgerLive = Layer.succeed(Ledger, { total: Effect.succeed(42) });

class Bank extends AuthPlugin.Service<Bank, { readonly name: string }>()("bank", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Bank, {
    exposes: { services: [Vault, Ledger], layer: Layer.mergeAll(VaultLive, LedgerLive) },
    // `make` may require what the plugin exposes: the exposed layer is built beneath it.
    make: Effect.gen(function* () {
      const vault = yield* Vault;
      return { name: yield* vault.secret };
    }),
  });
}

class Teller extends AuthPlugin.Service<Teller, { readonly total: Effect.Effect<number> }>()(
  "teller",
  { apiVersion: 1, contract: HttpApi.make("auth") },
) {
  static readonly layer = AuthPlugin.layer(Teller, {
    dependsOn: [Bank],
    make: Effect.gen(function* () {
      const ledger = yield* Ledger;
      return { total: ledger.total };
    }),
  });
}

class Bystander extends AuthPlugin.Service<Bystander, {}>()("bystander", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Bystander, { make: Effect.succeed({}) });
}

describe("exposes (ADR-EA-040)", () => {
  it.effect(
    "adds the exposed services to ROut and discharges a dependent's requirement in the fold",
    () =>
      Effect.gen(function* () {
        const auth = Auth.make([Bank, Teller, Bystander]);
        const context = yield* Layer.build(auth.layer);
        assert.strictEqual(yield* Context.get(context, Vault).secret, "swordfish");
        assert.strictEqual(yield* Context.get(context, Teller).total, 42);
        assert.strictEqual(Context.get(context, Bank).name, "swordfish");
      }).pipe(Effect.scoped),
  );

  it("is a readonly static of keys, and reaches the manifest without building a layer", () => {
    assert.deepStrictEqual(Bank.exposes, ["awthaq/plugin/bank/Vault", "awthaq/plugin/bank/Ledger"]);
    assert.deepStrictEqual(Teller.exposes, []);
    assert.deepStrictEqual(Auth.make([Bank, Teller]).manifest.exposes, [
      { plugin: "bank", key: "awthaq/plugin/bank/Vault" },
      { plugin: "bank", key: "awthaq/plugin/bank/Ledger" },
    ]);
  });

  it("an exposed service is in the exposer's ROut and out of its RIn", () => {
    type Provides = Layer.Success<typeof Bank.layer>;
    type Needs = Layer.Services<typeof Bank.layer>;
    const providesAll: [Bank | Vault | Ledger] extends [Provides] ? true : false = true;
    const needsNeither: [Vault | Ledger] extends [Needs] ? false : true = true;
    void providesAll;
    void needsNeither;
  });

  it("refuses, at compile time, a service keyed outside the exposer's namespace", () => {
    class Impostor extends AuthPlugin.Service<Impostor, {}>()("impostor", {
      apiVersion: 1,
      contract: HttpApi.make("auth"),
    }) {
      static readonly layer = AuthPlugin.layer(Impostor, {
        // @ts-expect-error — `awthaq/plugin/elsewhere/Stray` is not keyed `awthaq/plugin/impostor/...`
        exposes: { services: [Stray], layer: Layer.succeed(Stray, {}) },
        make: Effect.succeed({}),
      });
    }
    assert.deepStrictEqual(Impostor.exposes, ["awthaq/plugin/elsewhere/Stray"]);
  });

  it("refuses, at compile time, an exposed service missing from `services`", () => {
    class Sloppy extends AuthPlugin.Service<Sloppy, {}>()("bank", {
      apiVersion: 1,
      contract: HttpApi.make("auth"),
    }) {
      static readonly layer = AuthPlugin.layer(Sloppy, {
        // @ts-expect-error — `Ledger` is provided by the layer but not listed in `services`
        exposes: { services: [Vault], layer: Layer.mergeAll(VaultLive, LedgerLive) },
        make: Effect.succeed({}),
      });
    }
    assert.deepStrictEqual(Sloppy.exposes, ["awthaq/plugin/bank/Vault"]);
  });

  it("Validate refuses a plugin that requires an exposed service without `dependsOn`", () => {
    class Freeloader extends AuthPlugin.Service<Freeloader, {}>()("freeloader", {
      apiVersion: 1,
      contract: HttpApi.make("auth"),
    }) {
      static readonly layer = AuthPlugin.layer(Freeloader, {
        make: Effect.gen(function* () {
          yield* Ledger;
          return {};
        }),
      });
    }
    // @ts-expect-error — plugin "freeloader" requires a service exposed by "bank" — add bank to dependsOn
    Auth.make([Bank, Freeloader]);
    assert.strictEqual(Freeloader.dependsOn.length, 0);
  });

  it("Validate refuses a dependent listed without its exposer", () => {
    // @ts-expect-error — plugin "teller" depends on plugin "bank", which is not in the list
    Auth.make([Teller]);
    assert.strictEqual(Teller.dependsOn.length, 1);
  });
});
