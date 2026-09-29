// NAM-002 (.issues/high): `Password.signIn` consults the `BeforeSignIn` veto
// once the password is proven — where an Auth.js `signIn` callback returning
// `false` lands — and `signUp` fires `AfterSignUp` after the user is
// committed. A veto surfaces as the typed `HookAborted` and no session is
// issued.
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
  HookPoint,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const signedUp = Ref.makeUnsafe<
  ReadonlyArray<{ readonly userId: string; readonly email: string; readonly strategy: string }>
>([]);
const signUpStrategies = Ref.makeUnsafe<ReadonlyArray<string>>([]);

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
      Hooks.BeforeSignIn.tap((input) =>
        input.email === "banned@example.com"
          ? Effect.fail(new HookPoint.HookAbort({ code: "USER_BANNED" }))
          : Effect.succeed(input),
      ),
      Hooks.BeforeSignUp.tap((input) =>
        Ref.update(signUpStrategies, (seen) => [...seen, input.strategy]).pipe(Effect.as(input)),
      ),
      Hooks.AfterSignUp.tap((input) => Ref.update(signedUp, (seen) => [...seen, input])),
    ),
  ),
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
      secret: Redacted.make("password-before-signin-test-csrf-secret-padded-to-32-bytes"),
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

describe("Password BeforeSignIn / AfterSignUp hooks (NAM-002)", () => {
  it.effect(
    "a BeforeSignIn veto denies a correct-password sign-in with HookAborted and issues no session; AfterSignUp observes each sign-up",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const auditLog = yield* AuditLog.AuditLog;

        const banned = yield* password.signUp({
          email: "banned@example.com",
          password: strongPassword,
        });
        yield* users.verifyEmail(banned.session.userId);
        const ok = yield* password.signUp({ email: "ok@example.com", password: strongPassword });
        yield* users.verifyEmail(ok.session.userId);

        const issuedBefore = (yield* auditLog.list({ eventTag: "auth.session.issued" })).length;

        const aborted = yield* password
          .signIn({ email: "banned@example.com", password: strongPassword })
          .pipe(
            Effect.flip,
            Effect.flatMap((error) =>
              error._tag === "HookAborted" ? Effect.succeed(error) : Effect.die(error),
            ),
          );
        assert.strictEqual(aborted.point, "auth.user.signIn");
        assert.strictEqual(aborted.code, "USER_BANNED");
        assert.strictEqual(
          (yield* auditLog.list({ eventTag: "auth.session.issued" })).length,
          issuedBefore,
        );

        const issued = yield* password.signIn({
          email: "ok@example.com",
          password: strongPassword,
        });
        assert.strictEqual(issued.session.userId, ok.session.userId);

        // A wrong password never reaches the veto: it stays the uniform InvalidCredentials.
        const wrong = yield* password
          .signIn({ email: "banned@example.com", password: Redacted.make("not the password") })
          .pipe(Effect.flip);
        assert.strictEqual(wrong._tag, "InvalidCredentials");

        assert.deepStrictEqual(yield* Ref.get(signUpStrategies), ["password", "password"]);
        assert.deepStrictEqual(
          (yield* Ref.get(signedUp)).map((event) => [event.email, event.strategy]),
          [
            ["banned@example.com", "password"],
            ["ok@example.com", "password"],
          ],
        );
      }).pipe(Effect.provide(TestLayer)),
  );
});
