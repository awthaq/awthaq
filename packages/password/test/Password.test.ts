// spec/behaviors/15-password.md, BEH-EA-113 through BEH-EA-120.
//
// Real, in-memory domain-level tests (no HTTP layer here — see
// `@effect-auth/server/test/AuthHttp.test.ts` for the equivalent
// wire-level pattern this plugin could get its own version of later): a
// real `PasswordHasher.layerArgon2id` (real argon2id hashing, not a mock),
// a real in-memory `Mailer`/`AuthEvents`/`Users`/`Accounts`/`Sessions`/
// `Verification`, and a fake `HttpClient` only for the HIBP breach-check
// transport (the same category of swap `TestClock` is for time — not a
// business-logic mock).
import { createHash } from "node:crypto";
import { AuthEvents, Sessions, Users, Verification, Accounts } from "@effect-auth/core";
import { Mailer, PasswordHasher } from "@effect-auth/ports";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Password } from "../src/index.ts";

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

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(NodeCrypto.layer));

const PortsLive = Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerMemory).pipe(
  Layer.provideMerge(NodeCrypto.layer),
);

const TestLayer = Password.Password.layer.pipe(
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(PortsLive),
  Layer.provide(NoBreachHttpClient),
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
        const { session } = yield* password.signUp({ email, password: strongPassword });

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

  it.effect("BEH-EA-064/117: requestReset always succeeds; only a known email is mailed", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      yield* password.signUp({ email, password: strongPassword });
      yield* letForkedFibersRun; // let signUp's own verification mail land first

      yield* password.requestReset({ email: "nobody@example.com" });
      const afterUnknown = yield* mailer.sent;
      assert.strictEqual(afterUnknown.filter((m) => m.template === "reset-password").length, 0);

      yield* password.requestReset({ email });
      const afterKnown = yield* mailer.sent;
      assert.strictEqual(afterKnown.filter((m) => m.template === "reset-password").length, 1);
    }).pipe(Effect.provide(TestLayer)),
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
          userId: (yield* sessions.verify(firstToken)).userId,
        });

        yield* password.requestReset({ email });
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
    "BEH-EA-059/118: replaying an already-consumed reset token fails with TokenConsumed",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
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
            Layer.provideMerge(CoreLive),
            Layer.provideMerge(PortsLive),
            Layer.provide(BreachedHttpClient),
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
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(PortsLive),
          Layer.provide(UnavailableHttpClient),
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
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(PortsLive),
          Layer.provide(UnavailableHttpClient),
          Layer.provideMerge(Password.config({ breachCheck: { onUnavailable: "reject" } })),
        ),
      ),
    ),
  );
});
