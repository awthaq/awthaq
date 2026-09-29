// ARF-005 (wayfinder ticket 05, Fix B), BEH-EA-256: `confirmReset` consults the
// `BeforeCredentialReset` veto inside its transaction, after the emailed token is consumed and
// before the credential is rewritten and the sessions revoked — so mailbox possession alone
// cannot downgrade an account a second factor protects. `@awthaq/two-factor`'s
// `credentialResetGate` is the real tap; here a stand-in tap pins the seam itself.
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Hooks,
  HookPoint,
  RateLimits,
  Sessions,
  Users,
  Verification,
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
import { tokenOf } from "./harness.ts";

const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/** What the stand-in tap saw, so a test can assert the veto ran with (or without) a code. */
const seen = Ref.makeUnsafe<ReadonlyArray<{ readonly userId: string; readonly code?: string }>>([]);

/** A stand-in for `TwoFactor.credentialResetGate`: the reset of `guarded@example.com`'s account needs the code "123456". */
const guardedUserId = Ref.makeUnsafe<string | undefined>(undefined);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(
    Hooks.BeforeCredentialReset.tap((input) =>
      Effect.gen(function* () {
        const code =
          input.secondFactorCode === undefined ? undefined : Redacted.value(input.secondFactorCode);
        yield* Ref.update(seen, (all) => [
          ...all,
          { userId: input.userId, ...(code === undefined ? {} : { code }) },
        ]);
        const guarded = yield* Ref.get(guardedUserId);
        if (guarded === input.userId && code === undefined) {
          return yield* Effect.fail(new HookPoint.HookAbort({ code: "TWO_FACTOR_REQUIRED" }));
        }
        if (guarded === input.userId && code !== "123456") {
          return yield* Effect.fail(new HookPoint.HookAbort({ code: "SECOND_FACTOR_INVALID" }));
        }
        return input;
      }),
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
      secret: Redacted.make("password-credential-reset-test-csrf-secret-padded-32"),
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

const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

const oldPassword = Redacted.make("correct horse battery staple");
const newPassword = Redacted.make("a brand new strong password");

/** Signs a user up, verifies the mailbox, and returns the mailed reset token. */
const enrolledUserWithResetToken = (email: string) =>
  Effect.gen(function* () {
    const password = yield* Password.Password;
    const mailer = yield* Mailer.Mailer;
    const issued = yield* password.signUp({ email, password: oldPassword });
    yield* letForkedFibersRun;
    const verifyMail = (yield* mailer.sent).findLast((mail) => mail.template === "verify-email");
    yield* password.verifyEmail({ token: Redacted.make(tokenOf(verifyMail)) });
    yield* password.requestReset({ email });
    yield* letForkedFibersRun;
    const resetMail = (yield* mailer.sent).findLast((mail) => mail.template === "reset-password");
    return { userId: issued.session.userId, token: Redacted.make(tokenOf(resetMail)) };
  });

describe("Password.confirmReset x BeforeCredentialReset (ARF-005)", () => {
  it.effect("an unguarded account resets as before (the veto passes through)", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const { token } = yield* enrolledUserWithResetToken("plain@example.com");
      yield* Ref.set(guardedUserId, undefined);
      yield* password.confirmReset({ token, password: newPassword });
      const signedIn = yield* password.signIn({ email: "plain@example.com", password: newPassword });
      assert.isDefined(signedIn.token);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a guarded account fails SecondFactorRequired without a code and its password is unchanged",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const { userId, token } = yield* enrolledUserWithResetToken("guarded@example.com");
        yield* Ref.set(guardedUserId, userId);

        const failure = yield* password.confirmReset({ token, password: newPassword }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SecondFactorRequired");

        // The old password still signs in: the credential was never rewritten.
        const stillOld = yield* password.signIn({
          email: "guarded@example.com",
          password: oldPassword,
        });
        assert.isDefined(stillOld.token);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a wrong code surfaces as the typed HookAborted naming the point", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const { userId, token } = yield* enrolledUserWithResetToken("wrongcode@example.com");
      yield* Ref.set(guardedUserId, userId);
      const failure = yield* password
        .confirmReset({ token, password: newPassword, secondFactorCode: Redacted.make("000000") })
        .pipe(Effect.flip);
      if (failure._tag !== "HookAborted") return assert.fail(failure._tag);
      assert.strictEqual(failure.point, "auth.credential.beforeReset");
      assert.strictEqual(failure.code, "SECOND_FACTOR_INVALID");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a valid code carries the reset through, and the tap saw it", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      yield* Ref.set(seen, []);
      const { userId, token } = yield* enrolledUserWithResetToken("goodcode@example.com");
      yield* Ref.set(guardedUserId, userId);
      yield* password.confirmReset({
        token,
        password: newPassword,
        secondFactorCode: Redacted.make("123456"),
      });
      const signedIn = yield* password.signIn({ email: "goodcode@example.com", password: newPassword });
      assert.isDefined(signedIn.token);
      assert.deepStrictEqual(yield* Ref.get(seen), [{ userId, code: "123456" }]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
