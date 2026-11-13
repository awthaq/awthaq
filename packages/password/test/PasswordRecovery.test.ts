// password-recovery-correctness: ARF-002/004/007/008 — the confirmReset and
// requestReset edges that used to burn tokens, 500, or strand an account.
import { TestAuth, TestMailbox } from "@awthaq/test";
import { Accounts, Users, Verification } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import { email, makeTestLayer, strongPassword, UnavailableHttpClient } from "./harness.ts";

const resetTokenFor = (nth = 1) =>
  Effect.gen(function* () {
    const box = yield* TestMailbox.Mailbox;
    return Redacted.make(
      TestMailbox.secret(yield* box.mail.waitFor({ template: "reset-password" }, { nth })),
    );
  });

describe("ARF-002: policy before consume", () => {
  it.effect(
    "a weak password fails WeakPassword and the same token still resets with a strong one",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
        const token = yield* resetTokenFor();

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
      }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("a breach-check outage under onUnavailable: reject never consumes the token", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const hasher = yield* PasswordHasher.PasswordHasher;
      // Seeded directly: this layer's own signUp is screened too and would refuse.
      const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Ada" });
      yield* accounts.link({
        userId: user.id,
        providerId: Accounts.PASSWORD_PROVIDER_ID,
        subject: user.id,
        credentialHash: Redacted.make(yield* hasher.hash(strongPassword)),
      });
      yield* password.requestReset({ email });
      const token = yield* resetTokenFor();

      const attempt = { token, password: Redacted.make("a brand new strong password") };
      const first = yield* password.confirmReset(attempt).pipe(Effect.flip);
      assert.strictEqual(first._tag, "WeakPassword");
      // Were the token consumed by the first attempt this would be TokenConsumed.
      const second = yield* password.confirmReset(attempt).pipe(Effect.flip);
      assert.strictEqual(second._tag, "WeakPassword");
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(
        makeTestLayer({
          httpClient: UnavailableHttpClient,
          config: { breachCheck: { onUnavailable: "reject" } },
        }),
      ),
    ),
  );
});

describe("BEH-EA-117: the new password is hashed only once the token is consumed", () => {
  it.effect("a well-formed reset token for no live row costs no password hash", () => {
    let hashes = 0;
    const CountingHasher = Layer.succeed(
      PasswordHasher.PasswordHasher,
      PasswordHasher.PasswordHasher.of({
        hash: () => Effect.sync(() => (hashes++, PasswordHasher.PhcHash("counted"))),
        verify: () => Effect.succeed(false),
        needsRehash: () => false,
      }),
    );
    return Effect.gen(function* () {
      const password = yield* Password.Password;
      const before = hashes;
      const failure = yield* password
        .confirmReset({
          token: Redacted.make("reset-password:u-nobody.not-a-live-secret"),
          password: Redacted.make("a brand new strong password"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "TokenConsumed");
      assert.strictEqual(hashes, before, "a dead token must not pay for a KDF");
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer({ hasher: CountingHasher })));
  });
});

describe("ARF-004: credential-less accounts", () => {
  it.effect(
    "requestReset for an account without a password credential mails reset-password-unavailable, no token",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const accounts = yield* Accounts.Accounts;
        const oauthOnly = yield* users.create({
          identity: { _tag: "Email", email: "oauth@example.com" },
          name: "Oauth",
        });
        yield* accounts.link({ userId: oauthOnly.id, providerId: "github", subject: "gh-1" });

        yield* password.requestReset({ email: "oauth@example.com" });
        const box = yield* TestMailbox.Mailbox;
        const notice = yield* box.mail.waitFor({
          template: "reset-password-unavailable",
        });
        yield* box.mail.refute({ template: "reset-password" });
        assert.strictEqual(notice.to, "oauth@example.com");
        assert.isUndefined(notice.data?.["token"]);
      }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("confirmReset for a credential-less user fails TokenConsumed, not a defect", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const verification = yield* Verification.Verification;
      const oauthOnly = yield* users.create({
        identity: { _tag: "Email", email: "oauth@example.com" },
        name: "Oauth",
      });
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
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );
});

describe("ARF-008: a reset proves mailbox control", () => {
  it.effect("an unverified user who completes confirmReset can then signIn", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      yield* password.signUp({ email, password: strongPassword });
      yield* password.requestReset({ email });
      const token = yield* resetTokenFor();

      const newPassword = Redacted.make("a brand new strong password");
      yield* password.confirmReset({ token, password: newPassword });

      const user = yield* users.findByEmail(email);
      assert.isTrue(Users.isEmailVerified(Option.getOrThrow(user)));
      const signedIn = yield* password.signIn({ email, password: newPassword });
      assert.isDefined(signedIn.token);
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );
});
