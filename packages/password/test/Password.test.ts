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
import { Accounts, AuditLog, Auth, AuthEvents, MailDispatch, Sessions, Users } from "@awthaq/core";
import { Mailer, PasswordHasher, RateLimiter } from "@awthaq/ports";
import { SignInProbe, TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Password from "../src/Password.ts";
import { makeTestLayer, NoBreachHttpClient, tokenOf } from "./harness.ts";

/** The composition every test shares: `Auth.make([Password])` through `TestAuth.layer` (`harness.ts`). */
const TestLayer = makeTestLayer();

/** TSS-001/TSS-002: a `Mailer` whose `send` never resolves: see the tests below that provide this in place of the default recording `Mailer.layerMemory`. */
const HangingMailerLayer: Layer.Layer<Mailer.Mailer> = Layer.succeed(
  Mailer.Mailer,
  Mailer.Mailer.of({ send: () => Effect.never, sent: Effect.succeed([]) }),
);

// ERS-002: scope close waits `drainTimeout` for in-flight mail; this mailer never finishes and `TestClock` never
// advances, so don't wait.
const TestLayerHangingMailer = TestAuth.layer(Auth.make([Password.Password]), {
  services: Layer.mergeAll(
    NoBreachHttpClient,
    Password.config({}),
    HangingMailerLayer,
    MailDispatch.config({ drainTimeout: Duration.zero }),
  ),
});

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
    const token = Redacted.make(tokenOf(verifyMail));
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-120: signUp rejects a too-short password with WeakPassword", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password
        .signUp({ email, password: Redacted.make("short") })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
  );

  it.effect("signUp rejects a duplicate email with EmailAlreadyExists", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      yield* password.signUp({ email, password: strongPassword });
      const failure = yield* password.signUp({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailAlreadyExists");
    }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
  );

  // BEH-EA-115/REQ-EA-312 (a compile-time property, so the BDD scenario is @skip'd in favour of
  // this): `Password.layer` bundles no hasher, so a composition that provides none is incomplete
  // — the requirement is still on the layer's type, and this line stops compiling if it is not.
  it("BEH-EA-115: Password.layer requires a PasswordHasher, it never supplies its own", () => {
    type Needs = Layer.Services<typeof Password.Password.layer>;
    const requiresHasher: PasswordHasher.PasswordHasher extends Needs ? true : false = true;
    assert.isTrue(requiresHasher);
  });

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
    }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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

        const oauthOnly = yield* users.create({
          identity: { _tag: "Email", email: "oauth@example.com" },
          name: "Oauth",
        });
        yield* accounts.link({
          userId: oauthOnly.id,
          providerId: "github",
          subject: "gh-1",
        });
        const noCredential = yield* password
          .signIn({ email: "oauth@example.com", password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(noCredential._tag, "InvalidCredentials");
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
  );

  it.effect(
    "SCP-001: a suspended user's correct-password signIn is refused with UserSuspended and issues no session; reactivating restores it",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const mailer = yield* Mailer.Mailer;
        const events = yield* AuthEvents.AuthEvents;
        yield* signUpAndVerify(password, mailer, { email, password: strongPassword });
        const user = Option.getOrThrow(yield* users.findByEmail(email));
        const before = (yield* sessions.list(user.id)).length;

        yield* users.setStatus(user.id, "suspended", { reason: "fraud" });
        const collected = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter(AuthEvents.is("auth.user.signInFailed")),
            Stream.take(2),
            Stream.runCollect,
          ),
        );
        yield* Effect.yieldNow;

        const refused = yield* password
          .signIn({ email, password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "UserSuspended");
        assert.strictEqual((yield* sessions.list(user.id)).length, before);

        // The gate sits after the credential proof: a wrong password on the same
        // suspended account still reads as InvalidCredentials (no suspension oracle).
        const wrong = yield* password
          .signIn({ email, password: Redacted.make("totally wrong password") })
          .pipe(Effect.flip);
        assert.strictEqual(wrong._tag, "InvalidCredentials");

        const reasons = Array.from(yield* Fiber.join(collected)).map((event) =>
          event._tag === "auth.user.signInFailed" ? event.reason : "?",
        );
        assert.deepStrictEqual(reasons, ["suspended", "invalidCredentials"]);

        yield* users.setStatus(user.id, "active");
        const restored = yield* password.signIn({ email, password: strongPassword });
        assert.strictEqual(restored.session.userId, user.id);
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
            Stream.filter(AuthEvents.is("auth.user.signInFailed")),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
            Stream.filter(AuthEvents.is("auth.user.signInFailed")),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
  );

  it.effect(
    "EOTS-001: every operation is an awthaq.password.<operation> span (plugin, strategy, user.id on success) and no attribute holds the email or password",
    () => {
      const spans: Array<Tracer.Span> = [];
      const base = Tracer.Tracer.defaultValue();
      const TracerLive = Layer.succeed(
        Tracer.Tracer,
        Tracer.make({
          span: (options) => {
            const span = base.span(options);
            spans.push(span);
            return span;
          },
        }),
      );
      return Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const issued = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });
        yield* password.signIn({ email, password: strongPassword });
        yield* password
          .signIn({ email, password: Redacted.make("totally wrong password") })
          .pipe(Effect.flip);

        const named = (name: string) => spans.filter((span) => span.name === name);
        assert.isAbove(named("awthaq.password.signUp").length, 0);
        assert.isAbove(named("awthaq.password.verifyEmail").length, 0);
        // Two sign-ins, and each does one real hash check under its own span.
        assert.strictEqual(named("awthaq.password.signIn").length, 2);
        assert.strictEqual(named("awthaq.password.verify").length, 2);
        const [successful] = named("awthaq.password.signIn");
        assert.strictEqual(successful?.attributes.get("awthaq.plugin"), "password");
        assert.strictEqual(successful?.attributes.get("auth.strategy"), "password");
        assert.strictEqual(successful?.attributes.get("user.id"), issued.session.userId);
        // The failed attempt never learns the user id.
        assert.isFalse(named("awthaq.password.signIn")[1]?.attributes.has("user.id") ?? true);

        const values = spans.flatMap((span) =>
          [...span.attributes.values()].map((value) => String(value)),
        );
        assert.isFalse(values.some((value) => value.includes(email)));
        assert.isFalse(values.some((value) => value.includes("correct horse battery staple")));
        assert.isFalse(values.some((value) => value.includes("totally wrong password")));
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(TracerLive.pipe(Layer.provideMerge(TestLayer))),
      );
    },
  );

  it.effect(
    "CSD-004: the failure event carries a keyed identifierDigest (the source ip is core's, SignIn.failed) — stable per identifier (existing account or not), distinct across identifiers, never the identifier itself",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const auditLog = yield* AuditLog.AuditLog;
        yield* password.signUp({ email, password: strongPassword });
        const wrong = Redacted.make("totally wrong password");
        const attempt = (who: string) =>
          password.signIn({ email: who, password: wrong }).pipe(Effect.flip);
        yield* attempt(email); // an existing account
        yield* attempt(email.toUpperCase()); // the same identifier, differently cased
        yield* attempt("nobody@example.com"); // no such account
        yield* attempt("nobody@example.com");

        const rows = yield* auditLog.list({ eventTag: "auth.user.signInFailed" });
        const failures = rows.flatMap((row) =>
          row.payload._tag === "auth.user.signInFailed" ? [row.payload] : [],
        );
        assert.strictEqual(failures.length, 4);
        for (const failure of failures) {
          assert.isString(failure.identifierDigest);
          assert.notProperty(failure, "userId");
          assert.notProperty(failure, "email");
        }
        const digests = new Set(failures.map((failure) => failure.identifierDigest));
        // {email, EMAIL} share one digest (normalized), {nobody} is another: two distinct values.
        assert.strictEqual(digests.size, 2);
        assert.isFalse(JSON.stringify(failures).includes("nobody"));
        assert.isFalse(JSON.stringify(failures).includes(email));
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
  );

  it.effect(
    "ARF-006: requestReset publishes auth.password.resetRequested for a real account only; verifyEmail publishes auth.user.emailVerified",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const auditLog = yield* AuditLog.AuditLog;
        const issued = yield* signUpAndVerify(password, mailer, {
          email,
          password: strongPassword,
        });

        const verified = yield* auditLog.list({ eventTag: "auth.user.emailVerified" });
        assert.strictEqual(verified.length, 1);
        assert.strictEqual(verified[0]?.actorUserId._tag, "Some");

        yield* password.requestReset({ email: "nobody@example.com" });
        yield* letForkedFibersRun;
        assert.strictEqual(
          (yield* auditLog.list({ eventTag: "auth.password.resetRequested" })).length,
          0,
        );

        yield* password.requestReset({ email });
        yield* letForkedFibersRun;
        const requested = yield* auditLog.list({ eventTag: "auth.password.resetRequested" });
        assert.strictEqual(requested.length, 1);
        const [row] = requested;
        assert.strictEqual(
          row?.payload._tag === "auth.password.resetRequested" ? row.payload.userId : "",
          issued.session.userId,
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
            Stream.filter(AuthEvents.is("auth.session.issued")),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
        yield* password.verifyEmail({ token: Redacted.make(tokenOf(verifyMail)) });
        yield* password.resendVerification({ email });
        yield* letForkedFibersRun;
        const afterVerified = yield* mailer.sent;
        assert.strictEqual(
          afterVerified.filter((mail) => mail.template === "verify-email").length,
          2,
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
    }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayerHangingMailer)),
  );

  it.effect(
    "TSS-002: resendVerification for a known, unverified account doesn't wait on mailer.send",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.resendVerification({ email });
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayerHangingMailer)),
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
        yield* password.verifyEmail({ token: Redacted.make(tokenOf(verifyMail)) });

        yield* password.requestReset({ email });
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        const resetMail = sent.find((m) => m.template === "reset-password");
        assert.isDefined(resetMail);
        const mailedToken = Redacted.make(tokenOf(resetMail));

        const newPassword = Redacted.make("a brand new strong password");
        yield* password.confirmReset({ token: mailedToken, password: newPassword });

        // BEH-EA-117: every *other* session is gone...
        const secondStillValid = yield* sessions.verify(second.token).pipe(Effect.flip);
        assert.strictEqual(secondStillValid._tag, "Sessions/NotFound");

        // ...and the new password actually works.
        const signedIn = yield* password.signIn({ email, password: newPassword });
        assert.isDefined(signedIn.token);
        const oldPasswordFails = yield* password
          .signIn({ email, password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(oldPasswordFails._tag, "InvalidCredentials");
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
        const mailedToken = Redacted.make(tokenOf(resetMail));

        const captured = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter(AuthEvents.is(["auth.password.resetCompleted", "auth.session.revoked"])),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
        assert.strictEqual(hijackedStillValid._tag, "Sessions/NotFound");

        const rotatedIsValid = yield* sessions.verify(rotated.token);
        assert.strictEqual(rotatedIsValid.session.id, rotated.session.id);
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
              AuthEvents.is([
                "auth.password.changed",
                "auth.session.revoked",
                "auth.session.issued",
              ]),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
    }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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
    }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-319: reauthenticate on a session that ended mid-request is Unauthenticated, not a defect",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const sessions = yield* Sessions.Sessions;
        const issued = yield* password.signUp({ email, password: strongPassword });
        // The middleware verified the session; then it was revoked before the write.
        yield* sessions.revoke(issued.session.id, "signOut");

        const failure = yield* password
          .reauthenticate({
            userId: issued.session.userId,
            currentSessionId: issued.session.id,
            currentPassword: strongPassword,
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Unauthenticated");
      }).pipe(TestAuth.withoutRequest, Effect.provide(TestLayer)),
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

        // EOTS-007: the breach is observable, and the audit payload carries
        // the rule that fired but never the email the bucket was keyed on.
        const auditLog = yield* AuditLog.AuditLog;
        const breaches = yield* auditLog.list({ eventTag: "auth.rateLimit.exceeded" });
        assert.strictEqual(breaches.length, 1);
        assert.isFalse(JSON.stringify(breaches[0]?.payload).includes(email));
        assert.strictEqual(JSON.stringify(breaches[0]?.payload).includes('"rule":"signIn"'), true);
      }).pipe(
        TestAuth.withoutRequest,
        // A real, enforcing limiter for this one test — every other test
        // in this file uses `RateLimiter.layerPermissive` via `TestLayer`'s
        // own `PortsLive`, deliberately, so this is the one place that
        // opts back into real enforcement.
        Effect.provide(
          makeTestLayer({
            limiter: RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
          }),
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
            .signIn({ email: `spray-${i}@example.com`, password: Redacted.make("wrong password") })
            .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
            .pipe(Effect.flip);
          assert.strictEqual(attempt._tag, "InvalidCredentials");
        }

        const throttled = yield* password
          .signIn({ email: "spray-30@example.com", password: Redacted.make("wrong password") })
          .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");

        // A different source IP, same never-seen email pattern, is
        // untouched by the first IP's exhausted budget.
        const otherIp = yield* password
          .signIn({ email: "spray-31@example.com", password: Redacted.make("wrong password") })
          .pipe(TestAuth.withRequest({ ip: "198.51.100.4" }))
          .pipe(Effect.flip);
        assert.strictEqual(otherIp._tag, "InvalidCredentials");
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(
          makeTestLayer({
            limiter: RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
          }),
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
          yield* password
            .requestReset({ email: `reset-spray-${i}@example.com` })
            .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }));
        }
        const throttled = yield* password
          .requestReset({ email: "reset-spray-30@example.com" })
          .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");

        // A different source IP is untouched by the first IP's exhausted
        // budget — `requestReset` always succeeds (`void`), so nothing to
        // flip here.
        yield* password
          .requestReset({ email: "reset-spray-31@example.com" })
          .pipe(TestAuth.withRequest({ ip: "198.51.100.4" }));
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(
          makeTestLayer({
            limiter: RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
          }),
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
      const realToken = tokenOf(verifyMail);
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
      TestAuth.withoutRequest,
      Effect.provide(
        makeTestLayer({
          limiter: RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
        }),
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
          yield* password
            .signUp({ email: `verify-spray-${i}@example.com`, password: strongPassword })
            .pipe(TestAuth.withRequest({ ip: `198.51.100.${100 + i}` }));
        }
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        for (let i = 0; i < 31; i++) {
          const mail = sent.find(
            (m) => m.template === "verify-email" && m.to === `verify-spray-${i}@example.com`,
          );
          const realToken = tokenOf(mail);
          identifiers.push(realToken.slice(0, realToken.lastIndexOf(".")));
        }

        for (let i = 0; i < 30; i++) {
          const attempt = yield* password
            .verifyEmail({ token: Redacted.make(`${identifiers[i]}.wrong-secret`) })
            .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
            .pipe(Effect.flip);
          assert.strictEqual(attempt._tag, "TokenConsumed");
        }

        const throttled = yield* password
          .verifyEmail({ token: Redacted.make(`${identifiers[30]}.wrong-secret`) })
          .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");

        // A different source IP, presenting its own never-before-seen
        // (still bogus) token, is untouched by the first IP's exhausted
        // budget.
        const untouched = yield* password
          .verifyEmail({ token: Redacted.make(`${identifiers[30]}.wrong-secret-2`) })
          .pipe(TestAuth.withRequest({ ip: "198.51.100.4" }))
          .pipe(Effect.flip);
        assert.strictEqual(untouched._tag, "TokenConsumed");
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(
          makeTestLayer({
            limiter: RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
          }),
        ),
      ),
  );

  it.effect(
    "APS-003: confirmReset is throttled per source IP across distinct, unrelated tokens, before the breach check",
    () => {
      let breachRequests = 0;
      const CountingHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          breachRequests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(`${"F".repeat(35)}:1`, { status: 200 }),
            ),
          );
        }),
      );
      return Effect.gen(function* () {
        const password = yield* Password.Password;
        // `RATE_LIMITS.confirmResetByIp` is `{ limit: 30, window: 15 minutes }`: 31 forged,
        // well-formed tokens with distinct public ids (so no per-token bucket trips first).
        for (let i = 0; i < 30; i++) {
          const attempt = yield* password
            .confirmReset({
              token: Redacted.make(`reset-password:forged-public-id-${i}.wrong`),
              password: strongPassword,
            })
            .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
            .pipe(Effect.flip);
          assert.strictEqual(attempt._tag, "TokenConsumed");
        }
        const throttled = yield* password
          .confirmReset({
            token: Redacted.make("reset-password:forged-public-id-30.wrong"),
            password: strongPassword,
          })
          .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
          .pipe(Effect.flip);
        assert.strictEqual(throttled._tag, "RateLimited");
        assert.isAtMost(breachRequests, 30);

        // Another source is untouched by the first one's exhausted budget.
        const untouched = yield* password
          .confirmReset({
            token: Redacted.make("reset-password:forged-public-id-31.wrong"),
            password: strongPassword,
          })
          .pipe(TestAuth.withRequest({ ip: "198.51.100.4" }))
          .pipe(Effect.flip);
        assert.strictEqual(untouched._tag, "TokenConsumed");
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(
          makeTestLayer({
            httpClient: CountingHttpClient,
            config: { breachCheck: true },
            limiter: RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
          }),
        ),
      );
    },
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
        TestAuth.withoutRequest,
        Effect.provide(
          makeTestLayer({
            limiter: RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
          }),
        ),
      ),
  );
});

// FAMS-003: the verified-email gate is a knob, and it never runs before the credentials are checked.
describe("FAMS-003: requireVerifiedEmail", () => {
  it.effect(
    "with requireVerifiedEmail: false an unverified user with correct credentials signs in",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        const issued = yield* password.signIn({ email, password: strongPassword });
        assert.isDefined(issued.token);
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(
          makeTestLayer({
            httpClient: NoBreachHttpClient,
            config: { requireVerifiedEmail: false },
          }),
        ),
      ),
  );

  it.effect("the credentials are still checked first when the gate is off", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      yield* password.signUp({ email, password: strongPassword });
      const failure = yield* password
        .signIn({ email, password: Redacted.make("totally wrong password") })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidCredentials");
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(makeTestLayer({ config: { requireVerifiedEmail: false } })),
    ),
  );
});

// ADR-EA-038: sign-in policy (gate, veto, divert, announcement) is tested once at `SignIn`; these prove
// only what the password plugin hands the module and how it answers a refusal.
describe("Password sign-in wiring (ADR-EA-038)", () => {
  it.effect("hands SignIn strategy password and amr [pwd]", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const probe = yield* SignInProbe.SignInProbe;
      const signedUp = yield* password.signUp({
        email: "wiring@example.com",
        password: strongPassword,
      });
      yield* users.verifyEmail(signedUp.session.userId);
      yield* password.signIn({ email: "wiring@example.com", password: strongPassword });
      const recorded = yield* probe.recorded;
      assert.deepStrictEqual(
        recorded.beforeSessionIssue.map((input) => [input.userId, input.strategy, input.amr]),
        // The sign-up's first session is a cleared sign-in too (createSignedIn), then the sign-in.
        [
          [signedUp.session.userId, "password", ["pwd"]],
          [signedUp.session.userId, "password", ["pwd"]],
        ],
      );
      assert.deepStrictEqual(
        recorded.beforeSignIn.map((input) => [input.email, input.strategy]),
        [
          ["wiring@example.com", "password"],
          ["wiring@example.com", "password"],
        ],
      );
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(SignInProbe.layer.pipe(Layer.provideMerge(TestLayer))),
    ),
  );

  it.effect(
    "EmailNotVerified precedes the suspension gate: a suspended unverified user learns neither",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const auditLog = yield* AuditLog.AuditLog;
        const signedUp = yield* password.signUp({
          email: "unverified@example.com",
          password: strongPassword,
        });
        yield* users.setStatus(signedUp.session.userId, "suspended");
        const refused = yield* password
          .signIn({ email: "unverified@example.com", password: strongPassword })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "EmailNotVerified");
        const failures = yield* auditLog.list({ eventTag: "auth.user.signInFailed" });
        assert.deepStrictEqual(
          failures.map((row) =>
            row.payload._tag === "auth.user.signInFailed" ? row.payload.reason : "?",
          ),
          ["emailNotVerified"],
        );
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(makeTestLayer({ config: { requireVerifiedEmail: true } })),
      ),
  );

  it.effect(
    "a user erased between the proof and the session is the uniform InvalidCredentials, announced as invalidCredentials",
    () => {
      const gone = { value: false };
      return Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const auditLog = yield* AuditLog.AuditLog;
        const signedUp = yield* password.signUp({
          email: "erased@example.com",
          password: strongPassword,
        });
        yield* users.verifyEmail(signedUp.session.userId);
        gone.value = true;
        const refused = yield* password
          .signIn({ email: "erased@example.com", password: strongPassword })
          .pipe(TestAuth.withRequest({ ip: "203.0.113.7" }))
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "InvalidCredentials");
        const failures = yield* auditLog.list({ eventTag: "auth.user.signInFailed" });
        assert.deepStrictEqual(
          failures.map((row) =>
            row.payload._tag === "auth.user.signInFailed" ? row.payload.reason : "?",
          ),
          ["invalidCredentials"],
        );
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(
          makeTestLayer({
            coreOverride: Layer.effect(
              Users.Users,
              Effect.map(Users.Users, (real) =>
                Users.Users.of({
                  ...real,
                  findById: (id) =>
                    gone.value
                      ? Effect.fail(new Users.UserNotFound({ id, message: "erased" }))
                      : real.findById(id),
                }),
              ),
            ),
          }),
        ),
      );
    },
  );
});
