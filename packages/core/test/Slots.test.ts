// spec/behaviors/03-ports-slots-hooks-registries.md, BEH-EA-017/019/021;
// spec/decisions/012-slots-exclusive-registries-aggregate.md (ADR-EA-012).
// See src/Slots.ts's own header comment for why BEH-EA-012's `SlotConflict`
// check is enforced at `Layer`-build time here, not by `Auth.make`'s type
// checker the way that behavior's own illustration shows — confirmed there
// via `Layer.Success<typeof Layer.effect(someReference, ...)>` resolving to
// `never` in this effect version, not the reference's own identity.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AuthPlugin } from "../src/index.ts";
import { Slots } from "../src/index.ts";

const fakePlugin = (id: string): AuthPlugin.Any => ({
  id,
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
});

interface ResolverShape {
  readonly resolve: () => string;
}

const Resolver = Slots.define<ResolverShape>()("Resolver", {
  defaultValue: () => ({ resolve: () => "identity-only" }),
});

describe("Slots.define (BEH-EA-017/021)", () => {
  it.effect("with nothing overriding it, the slot resolves to its fail-closed default", () =>
    Effect.gen(function* () {
      const resolved = yield* Resolver;
      assert.strictEqual(resolved.resolve(), "identity-only");
    }),
  );

  it.effect(
    "a plugin overriding the slot replaces the default, with no Slots.layer required",
    () => {
      const roles = fakePlugin("roles");
      return Effect.gen(function* () {
        const resolved = yield* Resolver;
        assert.strictEqual(resolved.resolve(), "with-roles");
      }).pipe(
        Effect.provide(
          Slots.override(roles, Resolver, Effect.succeed({ resolve: () => "with-roles" })),
        ),
      );
    },
  );
});

describe("Slots.SlotsRegistry (BEH-EA-012, opt-in)", () => {
  it.effect(
    "two plugins overriding the same slot is a SlotConflict once Slots.layer is provided",
    () => {
      const roles = fakePlugin("roles");
      const organization = fakePlugin("organization");
      const install = (owner: AuthPlugin.Any) =>
        Effect.scoped(
          Layer.build(Slots.override(owner, Resolver, Effect.succeed({ resolve: () => owner.id }))),
        );
      return Effect.gen(function* () {
        yield* install(roles);
        const failure = yield* install(organization).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SlotConflict");
        assert.strictEqual(failure.firstOwner, "roles");
        assert.strictEqual(failure.secondOwner, "organization");
        assert.strictEqual(failure.slot, Resolver.key);
      }).pipe(Effect.provide(Slots.layer));
    },
  );

  it.effect(
    "BEH-EA-024: claims freeze at first read — a claim registered afterward is a defect",
    () => {
      const roles = fakePlugin("roles");
      return Effect.gen(function* () {
        const registry = yield* Slots.SlotsRegistry;
        yield* registry.claimed;
        const exit = yield* Effect.exit(registry.claim(roles, Resolver));
        assert.isTrue(exit._tag === "Failure");
      }).pipe(Effect.provide(Slots.layer));
    },
  );
});
