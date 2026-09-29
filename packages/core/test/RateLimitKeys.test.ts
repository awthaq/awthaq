// PV-240/BEH-EA-108: a rule's key strategy ("principal" | "ip" | a function) is what its bucket key
// is derived from, not registry metadata. `RateLimits.bucketKey` resolves it against the request,
// namespaced by the rule so two rules never share a counter; `RateLimits.enforceRule` consumes it.
import { Api } from "@awthaq/api";
import { ClientAddress, RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as RateLimits from "../src/RateLimits.ts";

const request = HttpServerRequest.fromWeb(new Request("http://localhost/x"));

const principalOf = (id: string) =>
  Layer.succeed(
    Api.CurrentPrincipal,
    new Api.UserPrincipal({
      ref: new Api.PrincipalRef({ type: "user", id }),
      sessionId: "session-1",
    }),
  );

const addressLayer = (address: Option.Option<string>) =>
  Layer.succeed(ClientAddress.ClientAddress, {
    resolve: () => Effect.succeed(address),
  });

const rule = <K extends RateLimits.RateLimitKey>(key: K, endpoint = "create") => ({
  group: "invite",
  endpoint,
  key,
  limit: 2,
  window: Duration.minutes(1),
});

describe("RateLimits.bucketKey (PV-240, BEH-EA-108)", () => {
  it.effect('"principal" derives the key from CurrentPrincipal', () =>
    Effect.gen(function* () {
      const key = yield* RateLimits.bucketKey(rule("principal"));
      assert.include(key, "user:alice");
    }).pipe(Effect.provide(principalOf("alice"))),
  );

  it.effect("two principals get different buckets, one principal gets a stable one", () =>
    Effect.gen(function* () {
      const alice = yield* RateLimits.bucketKey(rule("principal")).pipe(
        Effect.provide(principalOf("alice")),
      );
      const aliceAgain = yield* RateLimits.bucketKey(rule("principal")).pipe(
        Effect.provide(principalOf("alice")),
      );
      const bob = yield* RateLimits.bucketKey(rule("principal")).pipe(
        Effect.provide(principalOf("bob")),
      );
      assert.strictEqual(alice, aliceAgain);
      assert.notStrictEqual(alice, bob);
    }),
  );

  it.effect('"ip" derives the key from the request\'s network origin', () =>
    Effect.gen(function* () {
      const key = yield* RateLimits.bucketKey(rule("ip")).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(addressLayer(Option.some("203.0.113.7"))),
      );
      assert.include(key, "203.0.113.7");
      const other = yield* RateLimits.bucketKey(rule("ip")).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(addressLayer(Option.some("198.51.100.9"))),
      );
      assert.notStrictEqual(key, other);
    }),
  );

  it.effect('"ip" with an unresolvable address falls into one shared, explicit bucket', () =>
    Effect.gen(function* () {
      const key = yield* RateLimits.bucketKey(rule("ip")).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(addressLayer(Option.none())),
      );
      assert.include(key, "unknown");
    }),
  );

  it.effect("a function key derives from the supplied input", () =>
    Effect.gen(function* () {
      const key = yield* RateLimits.bucketKey(
        rule((input) => `email:${String(input)}`),
        "a@example.com",
      );
      assert.include(key, "email:a@example.com");
    }),
  );

  it.effect("two rules with the same strategy never share a bucket", () =>
    Effect.gen(function* () {
      const create = yield* RateLimits.bucketKey(rule("principal", "create"));
      const revoke = yield* RateLimits.bucketKey(rule("principal", "revoke"));
      assert.notStrictEqual(create, revoke);
    }).pipe(Effect.provide(principalOf("alice"))),
  );
});

describe("RateLimits.enforceRule (PV-240)", () => {
  const Live = RateLimiter.layer.pipe(
    Layer.provide(RateLimiter.layerStoreMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
  );

  it.effect("admits up to the limit per principal, then refuses that principal only", () =>
    Effect.gen(function* () {
      const forAlice = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(principalOf("alice")));
      const forBob = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(principalOf("bob")));
      yield* forAlice(RateLimits.enforceRule(rule("principal")));
      yield* forAlice(RateLimits.enforceRule(rule("principal")));
      const refused = yield* forAlice(RateLimits.enforceRule(rule("principal"))).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "RateLimitExceeded");
      yield* forBob(RateLimits.enforceRule(rule("principal")));
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a breach is counted under the rule's dimension, never its key", () =>
    Effect.gen(function* () {
      const counter = Metric.withAttributes(RateLimits.exceededCounter, {
        group: "invite",
        endpoint: "create",
        rule: "invite.create",
        dimension: "principal",
      });
      const before = (yield* Metric.value(counter)).count;
      const limited = { ...rule("principal"), limit: 1 };
      yield* RateLimits.enforceRule(limited).pipe(Effect.provide(principalOf("carol")));
      const refused = yield* RateLimits.enforceRule(limited).pipe(
        Effect.provide(principalOf("carol")),
        Effect.flip,
      );
      assert.strictEqual(refused._tag, "RateLimitExceeded");
      assert.strictEqual((yield* Metric.value(counter)).count, before + 1);
    }).pipe(Effect.provide(Live)),
  );
});
