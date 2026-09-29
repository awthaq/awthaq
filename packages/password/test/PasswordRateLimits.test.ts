// password-rate-limit-hardening: RBS-006 (registry == enforcement, secret-free
// keys), MLO-003 (per-IP resend), TMS-006 (subaddress-normalized buckets).
import { RateLimits } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import * as PasswordRateLimits from "../src/PasswordRateLimits.ts";
import { letForkedFibersRun, makeTestLayer, strongPassword, tokenOf } from "./harness.ts";

const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

/** A limiter that permits everything and records the bucket key of every `consume`. */
const recordingLimiter = (keys: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(
    RateLimiter.RateLimiter,
    RateLimiter.RateLimiter.of({
      consume: (input) => Ref.update(keys, (existing) => [...existing, input.key]),
    }),
  );

describe("RBS-006: one definition feeds registry and enforcement", () => {
  it.effect(
    "every registered rule's key equals the key enforcement consumes for the same input",
    () =>
      Effect.gen(function* () {
        const keys = yield* Ref.make<ReadonlyArray<string>>([]);
        return yield* Effect.gen(function* () {
          const password = yield* Password.Password;
          const mailer = yield* Mailer.Mailer;
          const registry = yield* RateLimits.RateLimitsRegistry;
          const mixedCase = "Alice@X.com";
          const ip = "203.0.113.9";

          yield* password.signUp({ email: mixedCase, password: strongPassword, ip });
          yield* password
            .signIn({ email: mixedCase, password: strongPassword, ip })
            .pipe(Effect.flip);
          yield* password.requestReset({ email: mixedCase, ip });
          yield* password.resendVerification({ email: mixedCase, ip });
          yield* letForkedFibersRun;
          const sent = yield* mailer.sent;
          const resetToken = tokenOf(sent.findLast((m) => m.template === "reset-password"));
          const verifyToken = tokenOf(sent.findLast((m) => m.template === "verify-email"));
          yield* password.verifyEmail({ token: Redacted.make(verifyToken), ip });
          yield* password.confirmReset({
            token: Redacted.make(resetToken),
            password: Redacted.make("a brand new strong password"),
          });

          const enforced = new Set(yield* Ref.get(keys));
          // The rate-limit key names the token's public id (`<purpose>:<publicId>`), never its secret half.
        const identifierOf = (token: string) => token.slice(token.indexOf(":") + 1, token.lastIndexOf("."));
          // The union of every field any rule's key reads; each rule's schema
          // picks out the one(s) its endpoint names.
          const registered = yield* registry.registered;
          const expectedKeys = new Set<string>();
          for (const entry of registered) {
            if (typeof entry.key !== "function") continue;
            const inputs = [
              { email: mixedCase, ip, identifier: identifierOf(resetToken) },
              { email: mixedCase, ip, identifier: identifierOf(verifyToken) },
            ];
            for (const input of inputs) expectedKeys.add(entry.key(input));
          }
          // Everything enforced is described by a registered rule (changePassword
          // and reauthenticate are exercised in the HTTP suite).
          for (const key of enforced)
            assert.isTrue(expectedKeys.has(key), `unregistered key ${key}`);
          assert.isTrue(enforced.has("password:signup:alice@x.com"));
          assert.isTrue(enforced.has(`password:signup:ip:${ip}`));
          assert.isTrue(enforced.has("password:signin:alice@x.com"));
          assert.isTrue(enforced.has("password:reset-request:alice@x.com"));
          assert.isTrue(enforced.has("password:resend-verification:alice@x.com"));
          assert.isTrue(enforced.has(`password:verify-email:${identifierOf(verifyToken)}`));
          assert.isTrue(enforced.has(`password:reset-confirm:${identifierOf(resetToken)}`));
        }).pipe(Effect.provide(makeTestLayer({ limiter: recordingLimiter(keys) })));
      }),
  );

  it.effect("no registered key carries a token, a password or a payload", () =>
    Effect.gen(function* () {
      const registry = yield* RateLimits.RateLimitsRegistry;
      const registered = yield* registry.registered;
      const hostile = {
        token: "TOKEN-SECRET",
        password: "PASSWORD-SECRET",
        newPassword: "NEW-SECRET",
        currentPassword: "CURRENT-SECRET",
        email: "alice@x.com",
        identifier: "public-id",
        userId: "user-1",
        ip: "203.0.113.9",
      };
      assert.isAbove(registered.length, 0);
      for (const entry of registered) {
        if (typeof entry.key !== "function") continue;
        const key = entry.key(hostile);
        for (const secret of ["SECRET", "{", "}"]) assert.notInclude(key, secret);
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "a registry key given an input of the wrong shape reports an inert key, never a secret",
    () =>
      Effect.gen(function* () {
        const registry = yield* RateLimits.RateLimitsRegistry;
        const registered = yield* registry.registered;
        for (const entry of registered) {
          if (typeof entry.key !== "function") continue;
          assert.match(entry.key({ password: "PASSWORD-SECRET" }), /^password:/);
          assert.notInclude(entry.key({ password: "PASSWORD-SECRET" }), "SECRET");
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );
});

describe("MLO-003: resendVerification is throttled per source", () => {
  it.effect("one IP cannot request verification mails across distinct emails without bound", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      // `resendVerificationByIp` is 20 per 15 minutes.
      for (let i = 0; i < 20; i++) {
        yield* password.resendVerification({ email: `victim-${i}@example.com`, ip: "203.0.113.9" });
      }
      const throttled = yield* password
        .resendVerification({ email: "victim-20@example.com", ip: "203.0.113.9" })
        .pipe(Effect.flip);
      assert.strictEqual(throttled._tag, "RateLimited");
      // Another source is unaffected.
      yield* password.resendVerification({ email: "victim-21@example.com", ip: "198.51.100.4" });
    }).pipe(Effect.provide(makeTestLayer({ limiter: realLimiter }))),
  );
});

describe("TMS-006: subaddressed aliases share one per-email bucket", () => {
  it("defaultEmailRateKey lower-cases and strips the +tag only", () => {
    assert.strictEqual(PasswordRateLimits.defaultEmailRateKey("Victim+1@X.com"), "victim@x.com");
    assert.strictEqual(PasswordRateLimits.defaultEmailRateKey("victim@x.com"), "victim@x.com");
    assert.strictEqual(PasswordRateLimits.defaultEmailRateKey("+odd@x.com"), "+odd@x.com");
    assert.strictEqual(PasswordRateLimits.defaultEmailRateKey("no-at-sign"), "no-at-sign");
  });

  it.effect("signUp for victim+1..victim+6@x.com is throttled as one per-email bucket", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      // `signUp` is 5 per hour per email bucket; each alias is a distinct
      // literal address, all mapping to `victim@x.com`.
      for (let i = 1; i <= 5; i++) {
        yield* password.signUp({ email: `victim+${i}@x.com`, password: strongPassword });
      }
      const throttled = yield* password
        .signUp({ email: "victim+6@x.com", password: strongPassword })
        .pipe(Effect.flip);
      assert.strictEqual(throttled._tag, "RateLimited");
    }).pipe(Effect.provide(makeTestLayer({ limiter: realLimiter }))),
  );

  it.effect("rateLimitEmailKey is configurable", () =>
    Effect.gen(function* () {
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      return yield* Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password
          .signIn({ email: "a@example.com", password: strongPassword })
          .pipe(Effect.flip);
        assert.isTrue((yield* Ref.get(keys)).includes("password:signin:everyone"));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            limiter: recordingLimiter(keys),
            config: { rateLimitEmailKey: () => "everyone" },
          }),
        ),
      );
    }),
  );
});
