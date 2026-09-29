// BCR-004/THS-002 (.issues/high, wayfinder ticket 03): proves
// `Password.signIn` genuinely consults `Hooks.BeforeSessionIssue` (THE
// canonical MFA attachment point) and `Hooks.AfterSignIn` — a dedicated
// file, not folded into `Password.test.ts`, for the same reason
// `PasswordHooksSignUp.test.ts`'s own header comment gives.
//
// Both points are tapped once, up front, and exercised by two different
// emails within the *same* test — `flagged@example.com` diverts,
// `ada@example.com` continues through.
import {
  AuditLog,
  Hooks,
  AuthEvents,
  RateLimits,
  Sessions,
  Users,
  Verification,
  Accounts,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Password from "../src/Password.ts";

const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/** Recorded `AfterSignIn` observations, readable from outside the tap. */
const observations = Ref.makeUnsafe<
  ReadonlyArray<{ readonly userId: string; readonly strategy: string }>
>([]);

/**
 * `input.userId` is only known once `signUp` actually mints one (a
 * runtime-generated UUID) — the tap below can't hardcode it, so the test
 * body sets this once it has learned the flagged user's own real id.
 */
const flaggedUserId = Ref.makeUnsafe<Option.Option<string>>(Option.none());

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(
    Layer.mergeAll(
      // BEH-EA-093: diverts only the flagged user; every other user
      // continues through unaffected.
      Hooks.BeforeSessionIssue.tap((input) =>
        Ref.get(flaggedUserId).pipe(
          Effect.map((flagged) =>
            Option.isSome(flagged) && flagged.value === input.userId
              ? Option.some(
                  new Hooks.TwoFactorRequired({ userId: input.userId, challengeId: "chal-1" }),
                )
              : Option.none(),
          ),
        ),
      ),
      // BEH-EA-092: an observe tap's own failure must never affect the
      // sign-in it observes — recorded here, asserted from outside.
      Hooks.AfterSignIn.tap((input) =>
        Ref.update(observations, (current) => [...current, input]).pipe(
          Effect.andThen(Effect.fail("observer exploded, this must never surface")),
        ),
      ),
    ),
  ),
  // The taps require their points, so `HooksLive` feeds both (ELC-001).
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const PortsLive = Layer.mergeAll(
  PasswordHasher.layerArgon2id,
  Mailer.layerMemory,
  RateLimiter.layerPermissive,
).pipe(Layer.provideMerge(NodeCrypto.layer));

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("password-hooks-signin-test-csrf-secret"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const TestLayer = Password.Password.layer.pipe(
  Layer.provideMerge(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(PortsLive),
  Layer.provideMerge(RateLimits.layer),
  Layer.provide(NoBreachHttpClient),
  Layer.provide(SqlTransaction.layerNoop),
  Layer.provide(ClientAddress.layerDirect),
);

const strongPassword = Redacted.make("correct horse battery staple");

describe("Password signIn hooks (BEH-EA-092/093)", () => {
  it.effect(
    "BeforeSessionIssue diverts a flagged user to TwoFactorRequired, and AfterSignIn observes every completed sign-in",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;

        const flaggedSignUp = yield* password.signUp({
          email: "flagged-user@example.com",
          password: strongPassword,
        });
        yield* Ref.set(flaggedUserId, Option.some(flaggedSignUp.session.userId));
        yield* users.verifyEmail(flaggedSignUp.session.userId);

        const adaSignUp = yield* password.signUp({
          email: "ada@example.com",
          password: strongPassword,
        });
        yield* users.verifyEmail(adaSignUp.session.userId);

        // The flagged user's sign-in diverts — no session is issued, and
        // (BEH-EA-092) `AfterSignIn` never fires for it.
        const diverted = yield* password
          .signIn({ email: "flagged-user@example.com", password: strongPassword })
          .pipe(
            Effect.flip,
            Effect.flatMap((error) =>
              error._tag === "TwoFactorRequired" ? Effect.succeed(error) : Effect.die(error),
            ),
          );
        assert.strictEqual(diverted.challengeId, "chal-1");

        // An ordinary user's sign-in continues through unaffected, and
        // `AfterSignIn`'s own tap — which always fails — never surfaces
        // that failure to the caller (BEH-EA-092's own MUST).
        const issued = yield* password.signIn({
          email: "ada@example.com",
          password: strongPassword,
        });
        assert.isString(issued.session.userId);

        const seen = yield* Ref.get(observations);
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0]?.strategy, "password");
      }).pipe(Effect.provide(TestLayer)),
  );
});
