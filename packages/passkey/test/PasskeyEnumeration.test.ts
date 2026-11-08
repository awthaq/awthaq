// spec/behaviors/17-passkey.md, BEH-EA-131/136 — TC-001 (+CB-006,
// WPS-007), and the rate limits on the anonymous ceremony (WPS-005).
//
// BEH-EA-136's envelope has to cover the *options* half of the anonymous
// authenticate ceremony (what `allowCredentials` says about an email) and its
// cost (how much work an unknown credential id costs), not only the verify
// response's error tag.
import { TestAuth } from "@awthaq/test";
import { Users } from "@awthaq/core";
import * as Redacted from "effect/Redacted";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Passkey from "../src/Passkey.ts";
import { assertionCredential, mockWebAuthn } from "./passkeyTestFixtures.ts";
import { buildLayer, registerNewUser } from "./passkeyTestLayers.ts";

const decoysFor = (email: string) =>
  Effect.gen(function* () {
    const passkey = yield* Passkey.Passkey;
    const { options } = yield* passkey.authenticateOptions({ email });
    return options.allowCredentials ?? [];
  });

describe("TC-001: allowCredentials does not reveal which emails are registered", () => {
  it.effect(
    "an unknown email gets non-empty, deterministic descriptors shaped like a known user's",
    () =>
      Effect.gen(function* () {
        yield* registerNewUser("known@example.com");

        const unknownOnce = yield* decoysFor("nobody@example.com");
        const unknownTwice = yield* decoysFor("nobody@example.com");
        assert.isAbove(unknownOnce.length, 0);
        // Stable across calls — a per-call random decoy would itself be an oracle.
        assert.deepStrictEqual(unknownOnce, unknownTwice);
        // Case-insensitive, like the lookup itself.
        assert.deepStrictEqual(unknownOnce, yield* decoysFor("Nobody@Example.com"));

        const known = yield* decoysFor("known@example.com");
        assert.deepStrictEqual(
          known.map((descriptor) => descriptor.id),
          ["cred-mock-1"],
        );

        // Same descriptor shape: a base64url id of a realistic length, "public-key", transports.
        for (const descriptor of unknownOnce) {
          assert.strictEqual(descriptor.type, "public-key");
          assert.match(descriptor.id, /^[A-Za-z0-9_-]{43}$/);
          assert.isAbove(descriptor.transports?.length ?? 0, 0);
        }
        assert.deepStrictEqual(
          Object.keys(unknownOnce[0] ?? {}).sort(),
          Object.keys(known[0] ?? {}).sort(),
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("different unknown emails get different decoys", () =>
    Effect.gen(function* () {
      const a = yield* decoysFor("a@example.com");
      const b = yield* decoysFor("b@example.com");
      assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b));
    }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("a known user with no credentials is indistinguishable from an unknown email", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      yield* users.create({
        identity: { _tag: "Email", email: "empty@example.com" },
        name: "Empty",
      });
      const decoys = yield* decoysFor("empty@example.com");
      assert.isAbove(decoys.length, 0);
    }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect(
    "a configured enumerationSecret makes decoys stable across separately-built plugins",
    () => {
      const secret = Redacted.make("shared-enumeration-secret");
      const run = Effect.gen(function* () {
        return yield* decoysFor("stable@example.com");
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(buildLayer(mockWebAuthn(), { enumerationSecret: secret })),
      );
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* run, yield* run);
      });
    },
  );

  it.effect("a different enumerationSecret yields different decoys", () =>
    Effect.gen(function* () {
      const withSecret = (value: string) =>
        decoysFor("stable@example.com").pipe(
          TestAuth.withoutRequest,
          Effect.provide(buildLayer(mockWebAuthn(), { enumerationSecret: Redacted.make(value) })),
        );
      assert.notStrictEqual(
        JSON.stringify(yield* withSecret("secret-one")),
        JSON.stringify(yield* withSecret("secret-two")),
      );
    }),
  );

  it.effect(
    "an anonymous options call with no email still answers empty allowCredentials (discoverable flow)",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { options } = yield* passkey.authenticateOptions({});
        assert.deepStrictEqual(options.allowCredentials ?? [], []);
      }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

describe("WPS-005/TC-001: the anonymous ceremony is rate-limited", () => {
  const limited = buildLayer(mockWebAuthn(), undefined, { rateLimiter: "enforcing" });

  it.effect("authenticate/options is throttled per email", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      // 10 per 15 minutes per email (a fresh IP each time, so only the email budget can trip).
      for (let attempt = 0; attempt < 10; attempt++) {
        yield* passkey
          .authenticateOptions({ email: "probe@example.com" })
          .pipe(TestAuth.withRequest({ ip: `10.0.0.${attempt}` }));
      }
      const failure = yield* passkey
        .authenticateOptions({ email: "probe@example.com" })
        .pipe(TestAuth.withRequest({ ip: "10.0.1.1" }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
      // Another email from a fresh address is unaffected.
      yield* passkey
        .authenticateOptions({ email: "other@example.com" })
        .pipe(TestAuth.withRequest({ ip: "10.0.1.2" }));
    }).pipe(TestAuth.withoutRequest, Effect.provide(limited)),
  );

  it.effect(
    "TMS-006: case, whitespace and +tag aliases of one address share the email budget",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        // 10 per 15 minutes per address bucket; every alias is a distinct literal address (and a fresh
        // IP), so only a shared bucket can throttle them. Before the shared normaliser each `+N` alias
        // was a fresh budget.
        for (let attempt = 1; attempt <= 10; attempt++) {
          yield* passkey
            .authenticateOptions({
              email:
                attempt % 2 === 0
                  ? ` Victim+${attempt}@Example.com `
                  : `victim+${attempt}@example.com`,
            })
            .pipe(TestAuth.withRequest({ ip: `10.1.0.${attempt}` }));
        }
        const failure = yield* passkey
          .authenticateOptions({ email: "victim+11@example.com" })
          .pipe(TestAuth.withRequest({ ip: "10.1.1.1" }))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "RateLimited");
      }).pipe(TestAuth.withoutRequest, Effect.provide(limited)),
  );

  it.effect("authenticate/options is throttled per source address", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      for (let attempt = 0; attempt < 60; attempt++) {
        yield* passkey.authenticateOptions({}).pipe(TestAuth.withRequest({ ip: "192.0.2.7" }));
      }
      const failure = yield* passkey
        .authenticateOptions({})
        .pipe(TestAuth.withRequest({ ip: "192.0.2.7" }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
      yield* passkey.authenticateOptions({}).pipe(TestAuth.withRequest({ ip: "192.0.2.8" }));
    }).pipe(TestAuth.withoutRequest, Effect.provide(limited)),
  );

  it.effect("authenticate/verify is throttled per source address", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { ceremonyId, options } = yield* passkey
        .authenticateOptions({})
        .pipe(TestAuth.withRequest({ ip: "203.0.113.1" }));
      const attempt = () =>
        passkey
          .authenticateVerify({
            ceremonyId,
            credential: assertionCredential({ options, id: "no-such-credential" }),
          })
          .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }));
      for (let i = 0; i < 60; i++) yield* attempt().pipe(Effect.ignore);
      const failure = yield* attempt().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
    }).pipe(TestAuth.withoutRequest, Effect.provide(limited)),
  );
});

describe("WPS-005 admission: an authenticate/verify throttled by the per-source budget leaves its challenge live", () => {
  it.effect("the same response from another address is then verified", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      yield* registerNewUser("admission-throttle@example.com");
      const { ceremonyId, options } = yield* passkey
        .authenticateOptions({})
        .pipe(TestAuth.withRequest({ ip: "203.0.113.1" }));
      const credential = assertionCredential({ options });
      // Spend the budget of one address on attempts at other ceremonies.
      for (let i = 0; i < 60; i++) {
        yield* passkey
          .authenticateVerify({ ceremonyId: `other-${i}`, credential })
          .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
          .pipe(Effect.ignore);
      }
      const throttled = yield* passkey
        .authenticateVerify({ ceremonyId, credential })
        .pipe(TestAuth.withRequest({ ip: "203.0.113.9" }))
        .pipe(Effect.flip);
      assert.strictEqual(throttled._tag, "RateLimited");
      // Not an attempt: the challenge was not spent.
      const issued = yield* passkey
        .authenticateVerify({ ceremonyId, credential })
        .pipe(TestAuth.withRequest({ ip: "203.0.113.10" }));
      assert.isString(issued.session.userId);
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(buildLayer(mockWebAuthn(), undefined, { rateLimiter: "enforcing" })),
    ),
  );
});
