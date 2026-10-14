// password-rate-limit-hardening, behaviour half: RBS-006 (enforcement consumes only registered,
// secret-free buckets), MLO-003 (per-IP resend), TMS-006 (subaddress-normalized buckets). The key
// derivation itself is tested once in core (`RateLimitKey.test.ts`, `RateLimitBudget.test.ts`).
import { RateLimits } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import { letForkedFibersRun, makeTestLayer, strongPassword, tokenOf } from "./harness.ts";

const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

/** A limiter that permits everything and records the bucket key of every `consume`. */
const recordingLimiter = (keys: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(
    RateLimiter.RateLimiter,
    RateLimiter.RateLimiter.of({
      consume: (input) => Ref.update(keys, (existing) => [...existing, input.key]),
      check: () => Effect.void,
    }),
  );

describe("RBS-006: enforcement consumes only the buckets the registry reports", () => {
  it.effect("every key a flow consumes lives in a registered rule's bucket, secret-free", () =>
    Effect.gen(function* () {
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      return yield* Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        const registry = yield* RateLimits.RateLimitsRegistry;
        const ip = "203.0.113.9";

        yield* password.signUp({ email: "Alice@X.com", password: strongPassword, ip });
        yield* password
          .signIn({ email: "Alice@X.com", password: strongPassword, ip })
          .pipe(Effect.flip);
        yield* password.requestReset({ email: "Alice@X.com", ip });
        yield* password.resendVerification({ email: "Alice@X.com", ip });
        yield* letForkedFibersRun;
        const sent = yield* mailer.sent;
        const resetToken = tokenOf(sent.findLast((m) => m.template === "reset-password"));
        const verifyToken = tokenOf(sent.findLast((m) => m.template === "verify-email"));
        yield* password.verifyEmail({ token: Redacted.make(verifyToken), ip });
        yield* password.confirmReset({
          token: Redacted.make(resetToken),
          password: Redacted.make("a brand new strong password"),
        });

        const enforced = yield* Ref.get(keys);
        const buckets = (yield* registry.registered)
          .filter((entry) => entry.plugin === "password")
          .map((entry) => `ratelimit:${entry.bucket}:`);
        assert.isAbove(enforced.length, 0);
        for (const key of enforced) {
          assert.isTrue(
            buckets.some((bucket) => key.startsWith(bucket)),
            `unregistered key ${key}`,
          );
          // A key names the token's public id, never its secret half or the request payload.
          for (const secret of [
            "SECRET",
            "{",
            "}",
            "strong password",
            Redacted.value(strongPassword),
          ]) {
            assert.notInclude(key, secret);
          }
        }
        assert.isTrue(enforced.includes("ratelimit:password.signUp:email:alice@x.com"));
        assert.isTrue(enforced.includes(`ratelimit:password.signUpByIp:ip:${ip}`));
        assert.isTrue(enforced.includes("ratelimit:password.signIn:email:alice@x.com"));
        assert.isTrue(enforced.includes("ratelimit:password.requestReset:email:alice@x.com"));
        assert.isTrue(enforced.includes("ratelimit:password.resendVerification:email:alice@x.com"));
      }).pipe(Effect.provide(makeTestLayer({ limiter: recordingLimiter(keys) })));
    }),
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
        assert.isTrue((yield* Ref.get(keys)).includes("ratelimit:password.signIn:email:everyone"));
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
