// FAMS-004: the opt-in per-user custom-claims store (Firebase `setCustomUserClaims`, routed
// through qadi). Both layers run the same contract; then a real policy reads a migrated
// claim through the resolver.
import { AuditLog, AuthEvents, Auth, Hooks, Migrations, Users } from "@awthaq/core";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import {
  AttributeResolver,
  currentSubjectLayer,
  eq,
  evaluate,
  EvaluationServicesNone,
  fieldMatch,
  hasAttribute,
  isAllowed,
  literal,
  makeSubject,
  makeSubjectId,
} from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AttributeResolvers from "../src/AttributeResolvers.ts";
import * as Resolvers from "../src/Resolvers.ts";
import * as UserClaims from "../src/UserClaims.ts";

const CoreLive = AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory));

const withResolver = <E, R>(store: Layer.Layer<UserClaims.UserClaims, E, R>) =>
  UserClaims.UserClaimsAttributes.pipe(Layer.provideMerge(store));

const MemoryLayer = withResolver(UserClaims.UserClaims.layer).pipe(Layer.provideMerge(CoreLive));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(Migrations.run(UserClaims.UserClaims.migrations)).pipe(
  Layer.provide(SqlLive),
);
const SqlLayer = withResolver(UserClaims.UserClaims.layerSql).pipe(
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const alice = Users.UserId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const admin = Users.UserId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

const contract = (
  name: string,
  layer: Layer.Layer<
    UserClaims.UserClaims | AttributeResolver | AuditLog.AuditLog,
    unknown,
    never
  >,
) =>
  describe(name, () => {
    it.effect("a user with no claims reads as an empty record", () =>
      Effect.gen(function* () {
        const claims = yield* UserClaims.UserClaims;
        assert.deepStrictEqual(yield* claims.get(alice), {});
      }).pipe(Effect.provide(layer)),
    );

    it.effect("set replaces, merge is shallow, and a null value deletes a key", () =>
      Effect.gen(function* () {
        const claims = yield* UserClaims.UserClaims;
        yield* claims.set(alice, { plan: "pro", seats: 3 });
        assert.deepStrictEqual(yield* claims.get(alice), { plan: "pro", seats: 3 });

        const merged = yield* claims.merge(alice, { seats: 5, beta: true });
        assert.deepStrictEqual(merged, { plan: "pro", seats: 5, beta: true });

        yield* claims.merge(alice, { beta: null });
        assert.deepStrictEqual(yield* claims.get(alice), { plan: "pro", seats: 5 });

        yield* claims.set(alice, { only: "this" });
        assert.deepStrictEqual(yield* claims.get(alice), { only: "this" });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("delete clears every claim; claims are per user", () =>
      Effect.gen(function* () {
        const claims = yield* UserClaims.UserClaims;
        yield* claims.set(alice, { plan: "pro" });
        yield* claims.set(admin, { plan: "free" });
        yield* claims.delete(alice);
        assert.deepStrictEqual(yield* claims.get(alice), {});
        assert.deepStrictEqual(yield* claims.get(admin), { plan: "free" });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("a real change publishes auth.user.claimsUpdated with the keys and actor; a no-op publishes nothing", () =>
      Effect.gen(function* () {
        const claims = yield* UserClaims.UserClaims;
        const auditLog = yield* AuditLog.AuditLog;
        yield* claims.set(alice, { plan: "pro", seats: 3 }, { actorId: admin });
        yield* claims.merge(alice, { seats: 3 }, { actorId: admin });
        yield* claims.merge(alice, { seats: 4 }, { actorId: admin });
        const recorded = yield* auditLog.list({ eventTag: "auth.user.claimsUpdated" });
        assert.strictEqual(recorded.length, 2);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(admin));
        const payloads = recorded.map((row) => JSON.stringify(row.payload));
        // Keys only: claim values never enter the audit trail.
        assert.isTrue(payloads.every((p) => !p.includes("pro")));
        assert.isTrue(payloads.some((p) => p.includes("seats")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("the resolver answers `claims` for a user: subject, and nothing else", () =>
      Effect.gen(function* () {
        const claims = yield* UserClaims.UserClaims;
        const resolver = yield* AttributeResolver;
        yield* claims.set(alice, { plan: "pro" });
        assert.deepStrictEqual(
          yield* resolver.resolve(makeSubjectId(`user:${alice}`), "claims"),
          { plan: "pro" },
        );
        assert.isUndefined(yield* resolver.resolve(makeSubjectId(`user:${alice}`), "email"));
        assert.isUndefined(yield* resolver.resolve(makeSubjectId("apikey:k"), "claims"));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("a qadi policy on claims.plan allows or denies with the stored claim, no redeploy", () =>
      Effect.gen(function* () {
        const claims = yield* UserClaims.UserClaims;
        const isPro = hasAttribute(
          UserClaims.claimsAttr("claims"),
          fieldMatch("plan", eq(literal("pro"))),
        );
        // The real resolver goes innermost, so it (not the fail-closed default) answers.
        const resolver = yield* AttributeResolver;
        const askWith = evaluate(isPro).pipe(
          Effect.provideService(AttributeResolver, resolver),
          Effect.provide(
            Layer.mergeAll(
              EvaluationServicesNone,
              currentSubjectLayer(makeSubject({ id: `user:${alice}` })),
            ),
          ),
          Effect.map(isAllowed),
        );

        assert.isFalse(yield* askWith);
        yield* claims.set(alice, { plan: "pro" });
        assert.isTrue(yield* askWith);
        yield* claims.merge(alice, { plan: "free" });
        assert.isFalse(yield* askWith);
      }).pipe(Effect.provide(layer)),
    );
  });

contract("UserClaims (layer, memory)", MemoryLayer);
contract("UserClaims (layerSql)", SqlLayer);

describe("UserClaims composition", () => {
  it("is a plugin: Auth.make aggregates its table and migrations, and it contributes no groups", () => {
    assert.strictEqual(UserClaims.UserClaims.id, "claims");
    assert.deepStrictEqual(UserClaims.UserClaims.tables, ["claims_user"]);
    assert.strictEqual(UserClaims.UserClaims.migrations.length, 1);
    assert.throws(() => Auth.make([UserClaims.UserClaims]), /Auth.make requires at least one plugin/);
  });

  it("registers in attributeResolverRegistry next to UserAttributes without shadowing it", () => {
    const registry = AttributeResolvers.attributeResolverRegistry<
      never,
      Users.Users | UserClaims.UserClaims
    >([
      { names: Resolvers.UserAttributeNames, layer: Resolvers.UserAttributes },
      { names: UserClaims.UserClaimsAttributeNames, layer: UserClaims.UserClaimsAttributes },
    ]);
    assert.isDefined(registry);
    assert.deepStrictEqual(UserClaims.UserClaimsAttributeNames, ["claims"]);
    assert.isFalse(Object.hasOwn(Resolvers.UserAttributeSchemas, "claims"));
  });

  it.effect("changing claims announces AfterUserAttributesChanged so a cached decision is dropped", () =>
    Effect.gen(function* () {
      const announced: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const claims = yield* UserClaims.UserClaims;
        yield* claims.set(alice, { plan: "pro" });
      }).pipe(
        Effect.provide(
          UserClaims.UserClaims.layer.pipe(
            Layer.provideMerge(Hooks.AfterUserAttributesChanged.layer),
            Layer.provideMerge(
              Hooks.AfterUserAttributesChanged.tap((input) =>
                Effect.sync(() => {
                  announced.push(input.attributes);
                }),
              ),
            ),
            Layer.provideMerge(CoreLive),
          ),
        ),
      );
      assert.deepStrictEqual(announced, [["claims"]]);
    }),
  );

});
