// BEH-EA-175 (22-client-effect.feature), ADR-EA-045: a bearer client built the way the README says
// (`make(api, { transformClient: bearerTransformClient(store) })`) follows the session through the headers a
// declared response carries, with no call wrapped by hand. The client talks to a real `Password` composition
// served in process (`TestAuth.app`, reached through `fetch`), so what a scenario proves is the wire.
import { AuthClient } from "@awthaq/client";
import { Auth } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { TestAuth } from "@awthaq/test";
import { defineSteps } from "@effect-cucumber/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import assert from "node:assert/strict";
import { World } from "./ClientEffectWorld.ts";
import { isBoolean, isNumber } from "./shared/Outcomes.ts";

const built = Auth.make([Password.Password]);

const strongPassword = "correct horse battery staple";

/**
 * Runs `use` with a bearer client signed up against a fresh in-process server and the store it follows. A
 * failure is a defect: every step here expects the happy path.
 */
const withSignedUpClient = <A>(
  use: (signedUp: {
    readonly client: Effect.Success<ReturnType<typeof makeClient>>;
    readonly store: AuthClient.BearerTokenStoreShape;
  }) => Effect.Effect<A, unknown, AuthClient.BearerTokenStore>,
) =>
  Effect.gen(function* () {
    const app = TestAuth.app(TestAuth.layer(built, { services: TestAuth.httpClient.noBreach }));
    // `fetch` answered by the composition's own handler: the real wire, no socket.
    const inProcess: typeof globalThis.fetch = (input, init) =>
      app.handler(new Request(input, init));
    return yield* Effect.gen(function* () {
      const store = yield* AuthClient.BearerTokenStore;
      const client = yield* makeClient(store);
      yield* client.password.signUp({
        payload: { email: "bearer@example.com", password: Redacted.make(strongPassword) },
      });
      return yield* use({ client, store });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          AuthClient.CsrfClientNative,
          AuthClient.BearerTokenStoreMemory,
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, inProcess),
      Effect.ensuring(Effect.promise(app.dispose)),
    );
  }).pipe(Effect.orDie);

const makeClient = (store: AuthClient.BearerTokenStoreShape) =>
  AuthClient.make(built.api, {
    baseUrl: "http://localhost",
    transformClient: AuthClient.bearerTransformClient(store),
  });

export const bearerLifecycleSteps = defineSteps<World>(({ Given, When, Then }) => {
  Given("a bearer client signed up through the README's transform", function* () {
    yield* Effect.void;
  });

  When("the client changes its password without wrapping the call", function* () {
    const { outcomes } = yield* World;
    const reads = yield* withSignedUpClient(({ client }) =>
      Effect.gen(function* () {
        yield* client["password.account"].changePassword({
          payload: {
            currentPassword: Redacted.make(strongPassword),
            newPassword: Redacted.make("a whole new strong password"),
          },
        });
        // `200` when the stored token reads the caller's session, the status otherwise.
        const read = client.session.current().pipe(
          Effect.as(200),
          Effect.catchTag("Unauthenticated", () => Effect.succeed(401)),
        );
        return [yield* read, yield* read] as const;
      }),
    );
    yield* outcomes.set("firstRead", reads[0]);
    yield* outcomes.set("secondRead", reads[1]);
  });

  Then("the client's next two session reads both succeed", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("firstRead", isNumber), 200);
    assert.equal(yield* outcomes.getAs("secondRead", isNumber), 200);
  });

  When("the client signs out", function* () {
    const { outcomes } = yield* World;
    const held = yield* withSignedUpClient(({ client, store }) =>
      Effect.gen(function* () {
        const before = Option.isSome(yield* store.get);
        yield* client.session.signOut();
        return { before, after: Option.isSome(yield* store.get) };
      }),
    );
    yield* outcomes.set("heldBefore", held.before);
    yield* outcomes.set("heldAfter", held.after);
  });

  Then("the client's token store is empty", function* () {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("heldBefore", isBoolean), true);
    assert.equal(yield* outcomes.getAs("heldAfter", isBoolean), false);
  });
});
