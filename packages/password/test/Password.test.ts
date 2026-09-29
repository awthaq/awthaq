// spec/behaviors/15-password.md, BEH-EA-113 through BEH-EA-120.
//
// Real, in-memory domain-level tests (no HTTP layer here — see
// `@awthaq/server/test/AuthHttp.test.ts` for the equivalent
// wire-level pattern this plugin could get its own version of later): a
// real `PasswordHasher.layerArgon2id` (real argon2id hashing, not a mock),
// a real in-memory `Mailer`/`AuthEvents`/`Users`/`Accounts`/`Sessions`/
// `Verification`, and a fake `HttpClient` only for the HIBP breach-check
// transport (the same category of swap `TestClock` is for time — not a
// business-logic mock).
import { createHash } from "node:crypto";
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
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Password from "../src/Password.ts";

const sha1Hex = (plain: string): string =>
  createHash("sha1").update(plain).digest("hex").toUpperCase();

const httpClientReturning = (body: (url: string) => string): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body(request.url), { status: 200 })),
      ),
    ),
  );

/** BEH-EA-119: nothing in the corpus ever matches — the default, "not breached" transport. */
const NoBreachHttpClient = httpClientReturning(() => "");

const UnavailableHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request }),
      }),
    ),
  ),
);

// CSD-001: a resolved-but-non-2xx response (HIBP's own aggressive
// throttling makes 429 the most common failure mode at scale) — distinct
// from `UnavailableHttpClient`'s transport-level failure, since Effect's
// `HttpClient` resolves normally for any status.
const httpClientReturningStatus = (status: number): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status }))),
    ),
  );

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

/**
 * `changePassword` (ticket 11) needs `RateLimiter.layerPermissive` too
 * (ticket 12's own `rateLimit(...)` call sites use it), same reasoning:
 * a real, working default so an ordinary test loop never trips a limit
 * tuned for production, mirroring `TestAuth`'s own default.
 */
const PortsLive = Layer.mergeAll(
  PasswordHasher.layerArgon2id,
  Mailer.layerMemory,
  RateLimiter.layerPermissive,
).pipe(Layer.provideMerge(NodeCrypto.layer));

/**
 * `changePassword` (shipping-gap map, ticket 11) is the one endpoint in
 * this plugin's contract carrying `Authentication` middleware — building
 * `Password.layer` at all now needs it satisfied, even for these
 * domain-level tests that never go through HTTP.
 */
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

/**
 * CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `PasswordGroup` now
 * carries `.middleware(Api.CsrfProtection)` at the group level — building
 * `Password.Password.layer` at all now needs it satisfied, the same as
 * `AuthenticationLive` above, even though no HTTP request is ever issued
 * from this domain-level suite.
 */
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("password-domain-test-csrf-secret"),
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
  // ARF-001: `confirmReset` now runs inside a `SqlTransaction` — a no-op
  // wrapper for this in-memory composition.
  Layer.provide(SqlTransaction.layerNoop),
  Layer.provide(ClientAddress.layerDirect),
);

/** TSS-001/TSS-002: a `Mailer` whose `send` never resolves — see the tests below that provide this in place of `PortsLive`'s own `Mailer.layerMemory`. */
const HangingMailerLayer: Layer.Layer<Mailer.Mailer> = Layer.succeed(
  Mailer.Mailer,
  Mailer.Mailer.of({ send: () => Effect.never, sent: Effect.succeed([]) }),
);

const TestLayerHangingMailer = Password.Password.layer.pipe(
  Layer.provideMerge(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      PasswordHasher.layerArgon2id,
      HangingMailerLayer,
      RateLimiter.layerPermissive,
    ).pipe(Layer.provideMerge(NodeCrypto.layer)),
  ),
  Layer.provideMerge(RateLimits.layer),
  Layer.provide(NoBreachHttpClient),
  Layer.provide(SqlTransaction.layerNoop),
  Layer.provide(ClientAddress.layerDirect),
);

const email = "ada@example.com";
const strongPassword = Redacted.make("correct horse battery staple");

/**
 * `signUp`'s verification mail is dispatched via `Effect.forkDetach`
 * (BEH-EA-113: never awaited) — under `it.effect`'s `TestClock`, an
 * `Effect.sleep` wouldn't advance on its own, so a few cooperative
 * scheduler turns are what actually gives that detached fiber a chance to
 * run its two effectful steps to completion.
 */
const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/**
 * Upstream-hardening ticket 04: `signIn` now hard-blocks an unverified
 * account, so every test that needs a real, working sign-in after signUp
 * must consume the verification mail `signUp` already dispatches first —
 * mirrors what a real client would do, not a shortcut around the gate.
 */
const signUpAndVerify = (
  password: Password.PasswordShape,
  mailer: Mailer.MailerShape,
  input: {
    readonly email: string;
    readonly password: Redacted.Redacted<string>;
    readonly ip?: string;
    readonly userAgent?: string;
  },
) =>
  Effect.gen(function* () {
    const issued = yield* password.signUp(input);
    yield* letForkedFibersRun;
    const sent = yield* mailer.sent;
    const verifyMail = sent.findLast((mail) => mail.template === "verify-email");
    const token = Redacted.make(String(verifyMail?.data?.["token"]));
    yield* password.verifyEmail({ token });
    return issued;
  });

describe("Password", () => {
  it.effect(
    "BEH-EA-113: signUp creates a user, links a credential, issues a session, and mails a verification token",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const accounts = yield* Accounts.Accounts;
        const mailer = yield* Mailer.Mailer;

        const issued = yield* password.signUp({ email, password: strongPassword });

        const user = yield* users.findByEmail(email);
        assert.isTrue(Option.isSome(user));
        assert.strictEqual(issued.session.userId, Option.getOrThrow(user).id);

        const account = yield* accounts.findByProviderSubject(
          Accounts.PASSWORD_PROVIDER_ID,
          Option.getOrThrow(user).id,
        );
        assert.isTrue(Option.isSome(account));

        // BEH-EA-113: dispatched via `Effect.forkDetach` — give it a turn to run.
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0]?.template, "verify-email");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-120: signUp rejects a too-short password with WeakPassword", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password
        .signUp({ email, password: Redacted.make("short") })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("signUp rejects a duplicate email with EmailAlreadyExists", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      yield* password.signUp({ email, password: strongPassword });
      const failure = yield* password.signUp({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailAlreadyExists");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-114/116: signIn succeeds with correct credentials and does not spuriously rehash",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const accounts = yield* Accounts.Accounts;
        const mailer = yield* Mailer.Mailer;
        const { session } = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });

        const account = yield* accounts.findByProviderSubject(
          Accounts.PASSWORD_PROVIDER_ID,
          session.userId,
        );
        const hashBefore = yield* accounts.findCredentialHash(Option.getOrThrow(account).id);

        const issued = yield* password.signIn({ email, password: strongPassword });
        const user = yield* users.findById(session.userId);
        assert.strictEqual(issued.session.userId, user.id);

        // BEH-EA-116: a hash produced under the currently configured work
        // factor needs no rehash — the stored value is untouched.
        const hashAfter = yield* accounts.findCredentialHash(Option.getOrThrow(account).id);
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(hashBefore)),
          Redacted.value(Option.getOrThrow(hashAfter)),
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  // THS-003: how the session was authenticated.
  it.effect("THS-003: signUp, signIn and changePassword sessions carry amr [pwd]", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const signedUp = yield* signUpAndVerify(password, mailer, {
        email,
        password: strongPassword,
      });
      assert.deepStrictEqual(signedUp.session.amr, ["pwd"]);
      const signedIn = yield* password.signIn({ email, password: strongPassword });
      assert.deepStrictEqual(signedIn.session.amr, ["pwd"]);
      const changed = yield* password.changePassword({
        userId: signedUp.session.userId,
        currentSessionId: signedIn.session.id,
        currentPassword: strongPassword,
        newPassword: Redacted.make("another strong passphrase"),
      });
      assert.deepStrictEqual(changed.session.amr, ["pwd"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // CSD-003: request context recorded on every session-minting path.
  it.effect(
    "CSD-003: signUp, signIn and changePassword record ip and userAgent on the session",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const sessions = yield* Sessions.Sessions;
        const context = { ip: "203.0.113.7", userAgent: "Agent/1.0" };

        const signedUp = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
          ...context,
        });
        assert.deepStrictEqual(signedUp.session.ipAddress, Option.some(context.ip));
        assert.deepStrictEqual(signedUp.session.userAgent, Option.some(context.userAgent));

        const signedIn = yield* password.signIn({
          email,
          password: strongPassword,
          ip: "198.51.100.9",
          userAgent: "Agent/2.0",
        });
        const verified = yield* sessions.verify(signedIn.token);
        assert.deepStrictEqual(verified.session.ipAddress, Option.some("198.51.100.9"));
        assert.deepStrictEqual(verified.session.userAgent, Option.some("Agent/2.0"));

        const changed = yield* password.changePassword({
          userId: signedUp.session.userId,
          currentSessionId: signedIn.session.id,
          currentPassword: strongPassword,
          newPassword: Redacted.make("a different strong passphrase"),
          ip: "192.0.2.1",
          userAgent: "Agent/3.0",
        });
        assert.deepStrictEqual(changed.session.ipAddress, Option.some("192.0.2.1"));
        assert.deepStrictEqual(changed.session.userAgent, Option.some("Agent/3.0"));
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-114: signIn fails uniformly with InvalidCredentials for an unknown email, a wrong password, and a passwordless account",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const accounts = yield* Accounts.Accounts;
        yield* password.signUp({ email, password: strongPassword });

        const unknownEmail = yield* password
          .signIn({ email: "nobody@example.com", password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(unknownEmail._tag, "InvalidCredentials");

        const wrongPassword = yield* password
          .signIn({ email, password: Redacted.make("totally wrong password") })
          .pipe(Effect.flip);
        assert.strictEqual(wrongPassword._tag, "InvalidCredentials");

        const oauthOnly = yield* users.create({ email: "oauth@example.com", name: "Oauth" });
        yield* accounts.link({
          userId: oauthOnly.id,
          providerId: "github",
          subject: "gh-1",
        });
        const noCredential = yield* password
          .signIn({ email: "oauth@example.com", password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(noCredential._tag, "InvalidCredentials");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "upstream-hardening ticket 04: signIn hard-blocks an unverified account with otherwise-correct credentials",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        // No verifyEmail call — the account stays unverified.
        const failure = yield* password
          .signIn({ email, password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "EmailNotVerified");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "upstream-hardening ticket 04: the verification gate never leaks ahead of credential verification",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        // A wrong password on an unverified account still reports
        // InvalidCredentials, never EmailNotVerified — the gate can't be
        // used to probe whether a guessed password is close to correct.
        const failure = yield* password
          .signIn({ email, password: Redacted.make("totally wrong password") })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvalidCredentials");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "ALF-003: signIn publishes auth.user.signInFailed (reason: invalidCredentials) on a wrong password, with no userId/email in the payload",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const events = yield* AuthEvents.AuthEvents;
        yield* password.signUp({ email, password: strongPassword });

        const failed = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.user.signInFailed"),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        yield* password
          .signIn({ email, password: Redacted.make("totally wrong password") })
          .pipe(Effect.flip);

        const collected = yield* Fiber.join(failed);
        assert.strictEqual(collected.length, 1);
        const [event] = collected;
        assert.strictEqual(event?._tag, "auth.user.signInFailed");
        if (event?._tag === "auth.user.signInFailed") {
          assert.strictEqual(event.strategy, "password");
          assert.strictEqual(event.reason, "invalidCredentials");
          assert.notProperty(event, "userId");
          assert.notProperty(event, "email");
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "ALF-003: signIn publishes auth.user.signInFailed (reason: emailNotVerified) for an otherwise-correct, unverified account",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const events = yield* AuthEvents.AuthEvents;
        yield* password.signUp({ email, password: strongPassword });
        // No verifyEmail call — the account stays unverified.

        const failed = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.user.signInFailed"),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        yield* password.signIn({ email, password: strongPassword }).pipe(Effect.flip);

        const collected = yield* Fiber.join(failed);
        assert.strictEqual(collected.length, 1);
        const [event] = collected;
        assert.strictEqual(event?._tag, "auth.user.signInFailed");
        if (event?._tag === "auth.user.signInFailed") {
          assert.strictEqual(event.reason, "emailNotVerified");
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "ALF-004: signUp and signIn each publish auth.session.issued for the session they mint",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const events = yield* AuthEvents.AuthEvents;

        const issuedEvents = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.session.issued"),
            Stream.take(2),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        const signedUp = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });
        const signedIn = yield* password.signIn({ email, password: strongPassword });

        const collected = yield* Fiber.join(issuedEvents);
        assert.strictEqual(collected.length, 2);
        const [fromSignUp, fromSignIn] = collected;
        assert.strictEqual(fromSignUp?._tag, "auth.session.issued");
        assert.strictEqual(fromSignIn?._tag, "auth.session.issued");
        if (fromSignUp?._tag === "auth.session.issued") {
          assert.strictEqual(fromSignUp.sessionId, signedUp.session.id);
          assert.strictEqual(fromSignUp.userId, signedUp.session.userId);
        }
        if (fromSignIn?._tag === "auth.session.issued") {
          assert.strictEqual(fromSignIn.sessionId, signedIn.session.id);
          assert.strictEqual(fromSignIn.userId, signedIn.session.userId);
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "upstream-hardening ticket 04: signIn succeeds once verifyEmail has consumed signUp's own mailed token",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* signUpAndVerify(password, mailer, { email, password: strongPassword });
        const issued = yield* password.signIn({ email, password: strongPassword });
        assert.isDefined(issued.token);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "upstream-hardening ticket 04: resendVerification is enumeration-safe and mails only an existing, unverified account",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* password.signUp({ email, password: strongPassword });
        yield* letForkedFibersRun; // let signUp's own verification mail land first

        yield* password.resendVerification({ email: "nobody@example.com" });
        yield* letForkedFibersRun;
        const afterUnknown = yield* mailer.sent;
        assert.strictEqual(
          afterUnknown.filter((mail) => mail.template === "verify-email").length,
          1, // only signUp's own mail so far
        );

        yield* password.resendVerification({ email });
        yield* letForkedFibersRun;
        const afterKnown = yield* mailer.sent;
        assert.strictEqual(afterKnown.filter((mail) => mail.template === "verify-email").length, 2);

        // Once verified, a further resend mails nothing new — same
        // enumeration-safe response either way. `resendVerification`
        // reissues against the same identifier, atomically replacing the
        // still-live token signUp minted — the most recently mailed token
        // is the only one still valid, not the first.
        const verifyMail = afterKnown.findLast((mail) => mail.template === "verify-email");
        yield* password.verifyEmail({ token: Redacted.make(String(verifyMail?.data?.["token"])) });
        yield* password.resendVerification({ email });
        yield* letForkedFibersRun;
        const afterVerified = yield* mailer.sent;
        assert.strictEqual(
          afterVerified.filter((mail) => mail.template === "verify-email").length,
          2,
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-064/117: requestReset always succeeds; only a known email is mailed", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      yield* password.signUp({ email, password: strongPassword });
      yield* letForkedFibersRun; // let signUp's own verification mail land first

      yield* password.requestReset({ email: "nobody@example.com" });
      yield* letForkedFibersRun;
      const afterUnknown = yield* mailer.sent;
      assert.strictEqual(afterUnknown.filter((m) => m.template === "reset-password").length, 0);

      yield* password.requestReset({ email });
      yield* letForkedFibersRun;
      const afterKnown = yield* mailer.sent;
      assert.strictEqual(afterKnown.filter((m) => m.template === "reset-password").length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "TSS-001/EEM-001/MLO-001: requestReset for a known account doesn't wait on mailer.send",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        // Under `HangingMailerLayer` (below), `mailer.send` never resolves
        // — if `requestReset` awaited it inline (the pre-fix shape), this
        // call itself would never complete and the test would time out.
        // Completing proves the dispatch is genuinely forked, not just
        // that a mail eventually lands in some store.
        yield* password.requestReset({ email });
      }).pipe(Effect.provide(TestLayerHangingMailer)),
  );

  it.effect(
    "TSS-002: resendVerification for a known, unverified account doesn't wait on mailer.send",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.resendVerification({ email });
      }).pipe(Effect.provide(TestLayerHangingMailer)),
  );

  it.effect(
    "BEH-EA-117: confirmReset consumes the token, sets the new password, and revokes other sessions",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const sessions = yield* Sessions.Sessions;

        const { token: firstToken } = yield* password.signUp({ email, password: strongPassword });
        const second = yield* sessions.issue({
          userId: (yield* sessions.verify(firstToken)).session.userId,
        });

        // Upstream-hardening ticket 04: the final `signIn` below needs a
        // verified account — consume signUp's own dispatched mail first.
        yield* letForkedFibersRun;
        const verifyMail = (yield* mailer.sent).find((mail) => mail.template === "verify-email");
        yield* password.verifyEmail({ token: Redacted.make(String(verifyMail?.data?.["token"])) });

        yield* password.requestReset({ email });
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        const resetMail = sent.find((m) => m.template === "reset-password");
        assert.isDefined(resetMail);
        const mailedToken = Redacted.make(String(resetMail?.data?.["token"]));

        const newPassword = Redacted.make("a brand new strong password");
        yield* password.confirmReset({ token: mailedToken, password: newPassword });

        // BEH-EA-117: every *other* session is gone...
        const secondStillValid = yield* sessions.verify(second.token).pipe(Effect.flip);
        assert.strictEqual(secondStillValid._tag, "SessionNotFound");

        // ...and the new password actually works.
        const signedIn = yield* password.signIn({ email, password: newPassword });
        assert.isDefined(signedIn.token);
        const oldPasswordFails = yield* password
          .signIn({ email, password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(oldPasswordFails._tag, "InvalidCredentials");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "ALF-004: confirmReset publishes auth.password.resetCompleted and auth.session.revoked(reason: passwordReset), only after the transaction commits",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const events = yield* AuthEvents.AuthEvents;

        const issued = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });
        yield* password.requestReset({ email });
        yield* letForkedFibersRun;
        const resetMail = (yield* mailer.sent).findLast((m) => m.template === "reset-password");
        const mailedToken = Redacted.make(String(resetMail?.data?.["token"]));

        const captured = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter(
              (event) =>
                event._tag === "auth.password.resetCompleted" ||
                event._tag === "auth.session.revoked",
            ),
            Stream.take(2),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        const newPassword = Redacted.make("a brand new strong password");
        yield* password.confirmReset({ token: mailedToken, password: newPassword });

        const collected = yield* Fiber.join(captured);
        assert.strictEqual(collected.length, 2);
        const resetCompleted = collected.find((e) => e._tag === "auth.password.resetCompleted");
        const revoked = collected.find((e) => e._tag === "auth.session.revoked");
        assert.isDefined(resetCompleted);
        assert.isDefined(revoked);
        if (resetCompleted?._tag === "auth.password.resetCompleted") {
          assert.strictEqual(resetCompleted.userId, issued.session.userId);
        }
        if (revoked?._tag === "auth.session.revoked") {
          assert.strictEqual(revoked.userId, issued.session.userId);
          assert.strictEqual(revoked.reason, "passwordReset");
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-059/118: replaying an already-consumed reset token fails with TokenConsumed",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        const resetMail = sent.find((m) => m.template === "reset-password");
        const mailedToken = Redacted.make(String(resetMail?.data?.["token"]));

        yield* password.confirmReset({
          token: mailedToken,
          password: Redacted.make("first new password!"),
        });
        const replay = yield* password
          .confirmReset({ token: mailedToken, password: Redacted.make("second new password!") })
          .pipe(Effect.flip);
        assert.strictEqual(replay._tag, "TokenConsumed");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "confirmReset rejects a malformed token (no embedded identifier) with TokenConsumed",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const failure = yield* password
          .confirmReset({ token: Redacted.make("not-a-real-token"), password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TokenConsumed");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-119: a breached password is rejected with WeakPassword when breachCheck is on",
    () => {
      const breached = Redacted.make("pwned-password-123");
      const hex = sha1Hex(Redacted.value(breached));
      const prefix = hex.slice(0, 5);
      const suffix = hex.slice(5);
      // The real HIBP response format: one `SUFFIX:count` line per matching
      // entry sharing this SHA-1 prefix.
      const BreachedHttpClient = httpClientReturning((url) =>
        url.endsWith(prefix) ? `${suffix}:5` : "",
      );

      return Effect.gen(function* () {
        const password = yield* Password.Password;
        const failure = yield* password.signUp({ email, password: breached }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "WeakPassword");
      }).pipe(
        Effect.provide(
          Password.Password.layer.pipe(
            Layer.provideMerge(AuthenticationLive),
            Layer.provide(CsrfProtectionLive),
            Layer.provideMerge(CoreLive),
            Layer.provideMerge(PortsLive),
            Layer.provideMerge(RateLimits.layer),
            Layer.provide(BreachedHttpClient),
            Layer.provide(SqlTransaction.layerNoop),
            Layer.provide(ClientAddress.layerDirect),
            Layer.provideMerge(Password.config({ breachCheck: true })),
          ),
        ),
      );
    },
  );

  it.effect("BEH-EA-119: an unreachable breach check fails open by default", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const issued = yield* password.signUp({ email, password: strongPassword });
      assert.isDefined(issued.token);
    }).pipe(
      Effect.provide(
        Password.Password.layer.pipe(
          Layer.provideMerge(AuthenticationLive),
          Layer.provide(CsrfProtectionLive),
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(PortsLive),
          Layer.provideMerge(RateLimits.layer),
          Layer.provide(UnavailableHttpClient),
          Layer.provide(SqlTransaction.layerNoop),
          Layer.provide(ClientAddress.layerDirect),
          Layer.provideMerge(Password.config({ breachCheck: true })),
        ),
      ),
    ),
  );

  it.effect("BEH-EA-119: an unreachable breach check fails closed when configured", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password.signUp({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(
      Effect.provide(
        Password.Password.layer.pipe(
          Layer.provideMerge(AuthenticationLive),
          Layer.provide(CsrfProtectionLive),
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(PortsLive),
          Layer.provideMerge(RateLimits.layer),
          Layer.provide(UnavailableHttpClient),
          Layer.provide(SqlTransaction.layerNoop),
          Layer.provide(ClientAddress.layerDirect),
          Layer.provideMerge(Password.config({ breachCheck: { onUnavailable: "reject" } })),
        ),
      ),
    ),
  );

  // CSD-001: a resolved-but-non-2xx response (HIBP throttling, most common
  // at deployment scale) used to read as an ordinary body — its error text
  // would simply fail the suffix match and report "not breached" even
  // under `onUnavailable: "reject"`. These mirror the two
  // `UnavailableHttpClient` tests above exactly, substituting a 429/503
  // response for a transport failure, to prove HTTP-level failures now
  // route through the same `onUnavailable` branch as transport failures.
  it.effect("CSD-001: a 429 from the breach check fails open by default", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const issued = yield* password.signUp({ email, password: strongPassword });
      assert.isDefined(issued.token);
    }).pipe(
      Effect.provide(
        Password.Password.layer.pipe(
          Layer.provideMerge(AuthenticationLive),
          Layer.provide(CsrfProtectionLive),
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(PortsLive),
          Layer.provideMerge(RateLimits.layer),
          Layer.provide(httpClientReturningStatus(429)),
          Layer.provide(SqlTransaction.layerNoop),
          Layer.provide(ClientAddress.layerDirect),
          Layer.provideMerge(Password.config({ breachCheck: true })),
        ),
      ),
    ),
  );

  it.effect("CSD-001: a 503 from the breach check fails closed when configured", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password.signUp({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(
      Effect.provide(
        Password.Password.layer.pipe(
          Layer.provideMerge(AuthenticationLive),
          Layer.provide(CsrfProtectionLive),
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(PortsLive),
          Layer.provideMerge(RateLimits.layer),
          Layer.provide(httpClientReturningStatus(503)),
          Layer.provide(SqlTransaction.layerNoop),
          Layer.provide(ClientAddress.layerDirect),
          Layer.provideMerge(Password.config({ breachCheck: { onUnavailable: "reject" } })),
        ),
      ),
    ),
  );

  it.effect(
    "shipping-gaps/11: changePassword rotates the hash and rejects a wrong current password",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const issued = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });
        const userId = issued.session.userId;
        const currentSessionId = issued.session.id;

        const wrong = yield* password
          .changePassword({
            userId,
            currentSessionId,
            currentPassword: Redacted.make("totally wrong password"),
            newPassword: Redacted.make("a whole new strong password"),
          })
          .pipe(Effect.flip);
        assert.strictEqual(wrong._tag, "WrongPassword");

        const rotated = yield* password.changePassword({
          userId,
          currentSessionId,
          currentPassword: strongPassword,
          newPassword: Redacted.make("a whole new strong password"),
        });
        // BEH-EA-053: the caller's own session is rotated (superseded),
        // not merely kept — a genuinely new session id, not the old one.
        assert.notStrictEqual(rotated.session.id, currentSessionId);

        const oldFails = yield* password
          .signIn({ email, password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(oldFails._tag, "InvalidCredentials");

        const newWorks = yield* password.signIn({
          email,
          password: Redacted.make("a whole new strong password"),
        });
        assert.strictEqual(newWorks.session.userId, userId);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "PIL-002/RRS-001/SMS-001: changePassword revokes every other session, closing a hijacked-session hold",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const sessions = yield* Sessions.Sessions;
        const mailer = yield* Mailer.Mailer;
        const first = yield* signUpAndVerify(password, mailer, { email, password: strongPassword });
        // A second, independent session for the same user — stands in for
        // an attacker's hijacked session, or simply the user's other
        // device.
        const hijacked = yield* password.signIn({ email, password: strongPassword });

        const rotated = yield* password.changePassword({
          userId: first.session.userId,
          currentSessionId: first.session.id,
          currentPassword: strongPassword,
          newPassword: Redacted.make("a whole new strong password"),
        });

        const hijackedStillValid = yield* sessions.verify(hijacked.token).pipe(Effect.flip);
        assert.strictEqual(hijackedStillValid._tag, "SessionNotFound");

        const rotatedIsValid = yield* sessions.verify(rotated.token);
        assert.strictEqual(rotatedIsValid.session.id, rotated.session.id);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "ALF-004: changePassword publishes auth.password.changed, auth.session.revoked(reason: passwordChanged), and auth.session.issued for the rotated session",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const events = yield* AuthEvents.AuthEvents;
        const issued = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });
        const userId = issued.session.userId;
        const currentSessionId = issued.session.id;

        const captured = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter(
              (event) =>
                event._tag === "auth.password.changed" ||
                event._tag === "auth.session.revoked" ||
                event._tag === "auth.session.issued",
            ),
            Stream.take(3),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        const rotated = yield* password.changePassword({
          userId,
          currentSessionId,
          currentPassword: strongPassword,
          newPassword: Redacted.make("a whole new strong password"),
        });

        const collected = yield* Fiber.join(captured);
        assert.strictEqual(collected.length, 3);
        const changed = collected.find((e) => e._tag === "auth.password.changed");
        const revoked = collected.find((e) => e._tag === "auth.session.revoked");
        const sessionIssued = collected.find((e) => e._tag === "auth.session.issued");
        assert.isDefined(changed);
        assert.isDefined(revoked);
        assert.isDefined(sessionIssued);
        if (changed?._tag === "auth.password.changed") {
          assert.strictEqual(changed.userId, userId);
        }
        if (revoked?._tag === "auth.session.revoked") {
          assert.strictEqual(revoked.userId, userId);
          assert.strictEqual(revoked.reason, "passwordChanged");
        }
        if (sessionIssued?._tag === "auth.session.issued") {
          assert.strictEqual(sessionIssued.sessionId, rotated.session.id);
          assert.strictEqual(sessionIssued.userId, userId);
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shipping-gaps/11: changePassword rejects a weak new password", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const issued = yield* password.signUp({ email, password: strongPassword });

      const failure = yield* password
        .changePassword({
          userId: issued.session.userId,
          currentSessionId: issued.session.id,
          currentPassword: strongPassword,
          newPassword: Redacted.make("short"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "ticket 15 (AAPS-001): reauthenticate refreshes authenticatedAt without minting a new session",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const sessions = yield* Sessions.Sessions;
        const mailer = yield* Mailer.Mailer;
        const issued = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });
        const currentSessionId = issued.session.id;

        yield* TestClock.adjust(Duration.minutes(30));

        yield* password.reauthenticate({
          userId: issued.session.userId,
          currentSessionId,
          currentPassword: strongPassword,
        });

        // Unlike `changePassword`, the session itself is unchanged — same
        // id, still verifies with the original token.
        const verified = yield* sessions.verify(issued.token);
        assert.strictEqual(verified.session.id, currentSessionId);
        assert.isAbove(
          DateTime.toEpochMillis(verified.session.authenticatedAt),
          DateTime.toEpochMillis(issued.session.authenticatedAt),
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ticket 15 (AAPS-001): reauthenticate rejects a wrong current password", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const issued = yield* password.signUp({ email, password: strongPassword });

      const failure = yield* password
        .reauthenticate({
          userId: issued.session.userId,
          currentSessionId: issued.session.id,
          currentPassword: Redacted.make("totally wrong password"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WrongPassword");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "shipping-gaps/12: signIn is actually throttled once its own rule's limit is exceeded",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });

        // `RATE_LIMITS.signIn` is `{ limit: 5, window: 15 minutes }` —
        // exhaust it with wrong-password attempts (each still a real,
        // uniform-cost `InvalidCredentials` up to the limit), then prove
        // the 6th is rejected by the limiter itself, before credential
        // verification ever runs.
        for (let i = 0; i < 5; i++) {
          const attempt = yield* password
            .signIn({ email, password: Redacted.make("wrong password") })
            .pipe(Effect.flip);
          assert.strictEqual(attempt._tag, "InvalidCredentials");
        }

        const throttled = yield* password
          .signIn({ email, password: Redacted.make("wrong password") })
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");
      }).pipe(
        // A real, enforcing limiter for this one test — every other test
        // in this file uses `RateLimiter.layerPermissive` via `TestLayer`'s
        // own `PortsLive`, deliberately, so this is the one place that
        // opts back into real enforcement.
        Effect.provide(
          Password.Password.layer.pipe(
            Layer.provideMerge(AuthenticationLive),
            Layer.provide(CsrfProtectionLive),
            Layer.provideMerge(CoreLive),
            Layer.provideMerge(
              Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerMemory).pipe(
                Layer.provideMerge(NodeCrypto.layer),
              ),
            ),
            Layer.provideMerge(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
            Layer.provideMerge(RateLimits.layer),
            Layer.provide(NoBreachHttpClient),
            Layer.provide(SqlTransaction.layerNoop),
            Layer.provide(ClientAddress.layerDirect),
          ),
        ),
      ),
  );

  it.effect(
    "RBS-001/CSD-002: signIn is throttled per source IP across distinct, unrelated emails",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;

        // `RATE_LIMITS.signInByIp` is `{ limit: 30, window: 15 minutes }` —
        // spray 30 distinct, never-registered emails from the same IP
        // (each still real, uniform-cost `InvalidCredentials`, exactly as
        // the per-email limiter's own test exhausts real attempts), then
        // prove the 31st — a brand-new email never seen before, so the
        // per-email limiter has no opinion on it — is rejected anyway,
        // because the per-IP budget (not the per-email one) is what's
        // exhausted.
        for (let i = 0; i < 30; i++) {
          const attempt = yield* password
            .signIn({
              email: `spray-${i}@example.com`,
              password: Redacted.make("wrong password"),
              ip: "203.0.113.9",
            })
            .pipe(Effect.flip);
          assert.strictEqual(attempt._tag, "InvalidCredentials");
        }

        const throttled = yield* password
          .signIn({
            email: "spray-30@example.com",
            password: Redacted.make("wrong password"),
            ip: "203.0.113.9",
          })
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");

        // A different source IP, same never-seen email pattern, is
        // untouched by the first IP's exhausted budget.
        const otherIp = yield* password
          .signIn({
            email: "spray-31@example.com",
            password: Redacted.make("wrong password"),
            ip: "198.51.100.4",
          })
          .pipe(Effect.flip);
        assert.strictEqual(otherIp._tag, "InvalidCredentials");
      }).pipe(
        Effect.provide(
          Password.Password.layer.pipe(
            Layer.provideMerge(AuthenticationLive),
            Layer.provide(CsrfProtectionLive),
            Layer.provideMerge(CoreLive),
            Layer.provideMerge(
              Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerMemory).pipe(
                Layer.provideMerge(NodeCrypto.layer),
              ),
            ),
            Layer.provideMerge(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
            Layer.provideMerge(RateLimits.layer),
            Layer.provide(NoBreachHttpClient),
            Layer.provide(SqlTransaction.layerNoop),
            Layer.provide(ClientAddress.layerDirect),
          ),
        ),
      ),
  );

  it.effect(
    "AGA-001/NHS-003: requestReset is throttled per source IP across distinct, unrelated emails",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;

        // `RATE_LIMITS.requestResetByIp` is `{ limit: 30, window: 15
        // minutes }` — spray 30 distinct, never-registered emails from
        // the same IP, then prove the 31st is throttled even though its
        // own email has never been requested before.
        for (let i = 0; i < 30; i++) {
          yield* password.requestReset({
            email: `reset-spray-${i}@example.com`,
            ip: "203.0.113.9",
          });
        }
        const throttled = yield* password
          .requestReset({ email: "reset-spray-30@example.com", ip: "203.0.113.9" })
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");

        // A different source IP is untouched by the first IP's exhausted
        // budget — `requestReset` always succeeds (`void`), so nothing to
        // flip here.
        yield* password.requestReset({ email: "reset-spray-31@example.com", ip: "198.51.100.4" });
      }).pipe(
        Effect.provide(
          Password.Password.layer.pipe(
            Layer.provideMerge(AuthenticationLive),
            Layer.provide(CsrfProtectionLive),
            Layer.provideMerge(CoreLive),
            Layer.provideMerge(
              Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerMemory).pipe(
                Layer.provideMerge(NodeCrypto.layer),
              ),
            ),
            Layer.provideMerge(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
            Layer.provideMerge(RateLimits.layer),
            Layer.provide(NoBreachHttpClient),
            Layer.provide(SqlTransaction.layerNoop),
            Layer.provide(ClientAddress.layerDirect),
          ),
        ),
      ),
  );

  it.effect("APS-003: verifyEmail is throttled per token identifier", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;

      yield* password.signUp({ email, password: strongPassword });
      yield* letForkedFibersRun; // let signUp's own verification mail land

      const sent = yield* mailer.sent;
      const verifyMail = sent.findLast((mail) => mail.template === "verify-email");
      const realToken = String(verifyMail?.data?.["token"]);
      const separator = realToken.lastIndexOf(".");
      const identifier = realToken.slice(0, separator);

      // `RATE_LIMITS.verifyEmail` is `{ limit: 5, window: 15 minutes }` —
      // exhaust it with wrong-secret guesses against the *real*
      // identifier (each still a genuine, uniform-cost `TokenConsumed` up
      // to the limit), then prove the 6th is rejected by the limiter
      // itself.
      for (let i = 0; i < 5; i++) {
        const attempt = yield* password
          .verifyEmail({ token: Redacted.make(`${identifier}.wrong-secret-${i}`) })
          .pipe(Effect.flip);
        assert.strictEqual(attempt._tag, "TokenConsumed");
      }

      const throttled = yield* password
        .verifyEmail({ token: Redacted.make(`${identifier}.wrong-secret-5`) })
        .pipe(Effect.flip);
      assert.strictEqual(throttled._tag, "RateLimited");
    }).pipe(
      Effect.provide(
        Password.Password.layer.pipe(
          Layer.provideMerge(AuthenticationLive),
          Layer.provide(CsrfProtectionLive),
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(
            Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerMemory).pipe(
              Layer.provideMerge(NodeCrypto.layer),
            ),
          ),
          Layer.provideMerge(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
          Layer.provideMerge(RateLimits.layer),
          Layer.provide(NoBreachHttpClient),
          Layer.provide(SqlTransaction.layerNoop),
          Layer.provide(ClientAddress.layerDirect),
        ),
      ),
    ),
  );

  it.effect(
    "APS-003: verifyEmail is throttled per source IP across distinct, unrelated tokens",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;

        // `RATE_LIMITS.verifyEmailByIp` is `{ limit: 30, window: 15
        // minutes }` — 31 distinct accounts, one wrong-secret guess each
        // (so no single account's own per-identifier limit trips first),
        // all from the same IP.
        const identifiers: Array<string> = [];
        for (let i = 0; i < 31; i++) {
          // A distinct, unrelated `ip` per signUp — `RATE_LIMITS.signUpByIp`
          // (20 per hour) is otherwise tripped by this test's own 31
          // sign-ups sharing a single key, before ever reaching the
          // `verifyEmail`-under-test throttling below.
          yield* password.signUp({
            email: `verify-spray-${i}@example.com`,
            password: strongPassword,
            ip: `198.51.100.${100 + i}`,
          });
        }
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        for (let i = 0; i < 31; i++) {
          const mail = sent.find(
            (m) => m.template === "verify-email" && m.to === `verify-spray-${i}@example.com`,
          );
          const realToken = String(mail?.data?.["token"]);
          identifiers.push(realToken.slice(0, realToken.lastIndexOf(".")));
        }

        for (let i = 0; i < 30; i++) {
          const attempt = yield* password
            .verifyEmail({
              token: Redacted.make(`${identifiers[i]}.wrong-secret`),
              ip: "203.0.113.9",
            })
            .pipe(Effect.flip);
          assert.strictEqual(attempt._tag, "TokenConsumed");
        }

        const throttled = yield* password
          .verifyEmail({
            token: Redacted.make(`${identifiers[30]}.wrong-secret`),
            ip: "203.0.113.9",
          })
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");

        // A different source IP, presenting its own never-before-seen
        // (still bogus) token, is untouched by the first IP's exhausted
        // budget.
        const untouched = yield* password
          .verifyEmail({
            token: Redacted.make(`${identifiers[30]}.wrong-secret-2`),
            ip: "198.51.100.4",
          })
          .pipe(Effect.flip);
        assert.strictEqual(untouched._tag, "TokenConsumed");
      }).pipe(
        Effect.provide(
          Password.Password.layer.pipe(
            Layer.provideMerge(AuthenticationLive),
            Layer.provide(CsrfProtectionLive),
            Layer.provideMerge(CoreLive),
            Layer.provideMerge(
              Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerMemory).pipe(
                Layer.provideMerge(NodeCrypto.layer),
              ),
            ),
            Layer.provideMerge(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
            Layer.provideMerge(RateLimits.layer),
            Layer.provide(NoBreachHttpClient),
            Layer.provide(SqlTransaction.layerNoop),
            Layer.provide(ClientAddress.layerDirect),
          ),
        ),
      ),
  );

  it.effect(
    "shipping-gaps/14: changePassword is actually throttled once its own rule's limit is exceeded",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const issued = yield* password.signUp({ email, password: strongPassword });
        const userId = issued.session.userId;
        const currentSessionId = issued.session.id;

        for (let i = 0; i < 5; i++) {
          const attempt = yield* password
            .changePassword({
              userId,
              currentSessionId,
              currentPassword: Redacted.make("wrong password"),
              newPassword: Redacted.make("a whole new strong password"),
            })
            .pipe(Effect.flip);
          assert.strictEqual(attempt._tag, "WrongPassword");
        }

        const throttled = yield* password
          .changePassword({
            userId,
            currentSessionId,
            currentPassword: Redacted.make("wrong password"),
            newPassword: Redacted.make("a whole new strong password"),
          })
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");
      }).pipe(
        Effect.provide(
          Password.Password.layer.pipe(
            Layer.provideMerge(AuthenticationLive),
            Layer.provide(CsrfProtectionLive),
            Layer.provideMerge(CoreLive),
            Layer.provideMerge(
              Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerMemory).pipe(
                Layer.provideMerge(NodeCrypto.layer),
              ),
            ),
            Layer.provideMerge(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
            Layer.provideMerge(RateLimits.layer),
            Layer.provide(NoBreachHttpClient),
            Layer.provide(SqlTransaction.layerNoop),
            Layer.provide(ClientAddress.layerDirect),
          ),
        ),
      ),
  );
});
