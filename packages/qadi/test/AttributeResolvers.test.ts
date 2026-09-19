// Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 14
// (AAPS-002).
import { AuthEvents, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AttributeResolver, makeSubjectId } from "@qadi/core";
import * as AttributeResolvers from "../src/AttributeResolvers.ts";
import * as Resolvers from "../src/Resolvers.ts";

const fakeResolver = (
  name: string,
  table: Readonly<Record<string, unknown>>,
): Layer.Layer<AttributeResolver> =>
  Layer.succeed(AttributeResolver, {
    name,
    resolve: (_subjectId, attribute) => Effect.succeed(table[attribute]),
  });

const CoreLive = Users.layerMemory.pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

describe("attributeResolverRegistry (AAPS-002)", () => {
  it.effect("dispatches each attribute to exactly the contribution that declared it", () =>
    Effect.gen(function* () {
      const registry = AttributeResolvers.attributeResolverRegistry([
        { names: ["a"], layer: fakeResolver("resolver-a", { a: 1 }) },
        { names: ["b"], layer: fakeResolver("resolver-b", { b: 2 }) },
      ]);
      const resolved = yield* Effect.gen(function* () {
        const resolver = yield* AttributeResolver;
        const a = yield* resolver.resolve(makeSubjectId("user:1"), "a");
        const b = yield* resolver.resolve(makeSubjectId("user:1"), "b");
        return { a, b };
      }).pipe(Effect.provide(registry));
      assert.strictEqual(resolved.a, 1);
      assert.strictEqual(resolved.b, 2);
    }),
  );

  it.effect("an attribute no contribution declared resolves to undefined", () =>
    Effect.gen(function* () {
      const registry = AttributeResolvers.attributeResolverRegistry([
        { names: ["a"], layer: fakeResolver("resolver-a", { a: 1 }) },
      ]);
      const value = yield* AttributeResolver.resolve(makeSubjectId("user:1"), "unknown").pipe(
        Effect.provide(registry),
      );
      assert.isUndefined(value);
    }),
  );

  it.effect(
    "two contributions naming the same attribute fail composition with DuplicateAttributeResolver",
    () =>
      Effect.gen(function* () {
        const registry = AttributeResolvers.attributeResolverRegistry([
          { names: ["email"], layer: fakeResolver("resolver-one", { email: "one" }) },
          { names: ["email", "plan"], layer: fakeResolver("resolver-two", { email: "two" }) },
        ]);
        const failure = yield* Effect.scoped(Layer.build(registry)).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "DuplicateAttributeResolver");
        assert.strictEqual(failure.attribute, "email");
        assert.deepStrictEqual(failure.contributors, ["resolver-one", "resolver-two"]);
      }),
  );

  // The actual AAPS-002 scenario: composing two real, independently-shipped
  // resolvers no longer silently drops one — both remain answerable through
  // the same composed `AttributeResolver`.
  it.effect(
    "composes two real, independently-shipped resolvers without either shadowing the other",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const user = yield* users.create({ email: "both@example.com", name: "Both" });
        const subjectId = makeSubjectId(`user:${user.id}`);

        const resolver = yield* AttributeResolver;
        const email = yield* resolver.resolve(subjectId, "email");
        const organizationCount = yield* resolver.resolve(subjectId, "organizationCount");

        assert.strictEqual(email, "both@example.com");
        assert.strictEqual(organizationCount, 3);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            AttributeResolvers.attributeResolverRegistry([
              { names: Resolvers.UserAttributeNames, layer: Resolvers.UserAttributes },
              { names: ["organizationCount"], layer: fakeResolver("orgs", { organizationCount: 3 }) },
            ]),
            CoreLive,
          ),
        ),
      ),
  );
});
