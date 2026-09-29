// password-recovery-correctness: ARF-002/004/007/008 — the confirmReset and
// requestReset edges that used to burn tokens, 500, or strand an account.
import { Accounts, Users, Verification } from "@awthaq/core";
import { Mailer, PasswordHasher } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import {
  email,
  letForkedFibersRun,
  makeTestLayer,
  strongPassword,
  tokenOf,
  UnavailableHttpClient,
} from "./harness.ts";

const mailedToken = (mailer: Mailer.MailerShape, template: string) =>
  Effect.gen(function* () {
    yield* letForkedFibersRun;
    const mail = (yield* mailer.sent).findLast((m) => m.template === template);
    assert.isDefined(mail);
    return Redacted.make(tokenOf(mail));
  });

describe("ARF-007: cross-purpose tokens", () => {
  it.effect(
    "a verify-email token presented to confirmReset fails TokenConsumed and stays usable for verifyEmail",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const users = yield* Users.Users;
        yield* password.signUp({ email, password: strongPassword });
        const verifyToken = yield* mailedToken(mailer, "verify-email");

        const failure = yield* password
          .confirmReset({
            token: verifyToken,
            password: Redacted.make("a brand new strong password"),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TokenConsumed");

        yield* password.verifyEmail({ token: verifyToken });
        const user = yield* users.findByEmail(email);
        assert.isTrue(Option.getOrThrow(user).emailVerified);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "a reset token presented to verifyEmail fails TokenConsumed and stays usable for confirmReset",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
        const resetToken = yield* mailedToken(mailer, "reset-password");

        const failure = yield* password.verifyEmail({ token: resetToken }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "TokenConsumed");

        yield* password.confirmReset({
          token: resetToken,
          password: Redacted.make("a brand new strong password"),
        });
      }).pipe(Effect.provide(makeTestLayer())),
  );
});

describe("ARF-002: policy before consume", () => {
  it.effect(
    "a weak password fails WeakPassword and the same token still resets with a strong one",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
        const token = yield* mailedToken(mailer, "reset-password");

        const weak = yield* password
          .confirmReset({ token, password: Redacted.make("short") })
          .pipe(Effect.flip);
        assert.strictEqual(weak._tag, "WeakPassword");

        // No `SqlTransaction` rollback exists in this composition — the
        // token survives only because the policy runs before it is consumed.
        yield* password.confirmReset({
          token,
          password: Redacted.make("a brand new strong password"),
        });
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("a breach-check outage under onUnavailable: reject never consumes the token", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const hasher = yield* PasswordHasher.PasswordHasher;
      // Seeded directly: this layer's own signUp is screened too and would refuse.
      const user = yield* users.create({ email, name: "Ada" });
      yield* accounts.link({
        userId: user.id,
        providerId: Accounts.PASSWORD_PROVIDER_ID,
        subject: user.id,
        credentialHash: Redacted.make(yield* hasher.hash(strongPassword)),
      });
      yield* password.requestReset({ email });
      const token = yield* mailedToken(mailer, "reset-password");

      const attempt = { token, password: Redacted.make("a brand new strong password") };
      const first = yield* password.confirmReset(attempt).pipe(Effect.flip);
      assert.strictEqual(first._tag, "WeakPassword");
      // Were the token consumed by the first attempt this would be TokenConsumed.
      const second = yield* password.confirmReset(attempt).pipe(Effect.flip);
      assert.strictEqual(second._tag, "WeakPassword");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          httpClient: UnavailableHttpClient,
          config: { breachCheck: { onUnavailable: "reject" } },
        }),
      ),
    ),
  );
});

describe("ARF-004: credential-less accounts", () => {
  it.effect(
    "requestReset for an account without a password credential mails reset-password-unavailable, no token",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const accounts = yield* Accounts.Accounts;
        const mailer = yield* Mailer.Mailer;
        const oauthOnly = yield* users.create({ email: "oauth@example.com", name: "Oauth" });
        yield* accounts.link({ userId: oauthOnly.id, providerId: "github", subject: "gh-1" });

        yield* password.requestReset({ email: "oauth@example.com" });
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        assert.strictEqual(sent.filter((m) => m.template === "reset-password").length, 0);
        const notice = sent.find((m) => m.template === "reset-password-unavailable");
        assert.isDefined(notice);
        assert.strictEqual(notice?.to, "oauth@example.com");
        assert.isUndefined(notice?.data?.["token"]);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("confirmReset for a credential-less user fails TokenConsumed, not a defect", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const verification = yield* Verification.Verification;
      const oauthOnly = yield* users.create({ email: "oauth@example.com", name: "Oauth" });
      // A token minted before this fix shipped (the old requestReset issued
      // one to every existing user, credential or not).
      const identifier = `reset-password:${oauthOnly.id}`;
      const { value } = yield* verification.issue({
        identifier,
        ttl: Duration.hours(1),
        userId: oauthOnly.id,
      });
      const failure = yield* password
        .confirmReset({
          token: Redacted.make(`${identifier}.${Redacted.value(value)}`),
          password: Redacted.make("a brand new strong password"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "TokenConsumed");
    }).pipe(Effect.provide(makeTestLayer())),
  );
});

describe("ARF-008: a reset proves mailbox control", () => {
  it.effect("an unverified user who completes confirmReset can then signIn", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const users = yield* Users.Users;
      yield* password.signUp({ email, password: strongPassword });
      yield* password.requestReset({ email });
      const token = yield* mailedToken(mailer, "reset-password");

      const newPassword = Redacted.make("a brand new strong password");
      yield* password.confirmReset({ token, password: newPassword });

      const user = yield* users.findByEmail(email);
      assert.isTrue(Option.getOrThrow(user).emailVerified);
      const signedIn = yield* password.signIn({ email, password: newPassword });
      assert.isDefined(signedIn.token);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
