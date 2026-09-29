// spec/behaviors/17-passkey.md, BEH-EA-131/136 — TC-001/TSS-004 (+CB-006,
// WPS-007), and the rate limits on the anonymous ceremony (WPS-005).
//
// BEH-EA-136's envelope has to cover the *options* half of the anonymous
// authenticate ceremony (what `allowCredentials` says about an email) and its
// cost (how much work an unknown credential id costs), not only the verify
// response's error tag.
import { Users } from "@awthaq/core";
import { WebAuthn } from "@awthaq/ports";
import * as Redacted from "effect/Redacted";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Passkey from "../src/Passkey.ts";
import { assertionCredential, mockWebAuthn } from "./passkeyTestFixtures.ts";
import { buildLayer, realRateLimiter, registerNewUser } from "./passkeyTestLayers.ts";

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
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("different unknown emails get different decoys", () =>
    Effect.gen(function* () {
      const a = yield* decoysFor("a@example.com");
      const b = yield* decoysFor("b@example.com");
      assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b));
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
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
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect(
    "a configured enumerationSecret makes decoys stable across separately-built plugins",
    () => {
      const secret = Redacted.make("shared-enumeration-secret");
      const run = Effect.gen(function* () {
        return yield* decoysFor("stable@example.com");
      }).pipe(Effect.provide(buildLayer(mockWebAuthn(), { enumerationSecret: secret })));
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* run, yield* run);
      });
    },
  );

  it.effect("a different enumerationSecret yields different decoys", () =>
    Effect.gen(function* () {
      const withSecret = (value: string) =>
        decoysFor("stable@example.com").pipe(
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
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

describe("TSS-004: an unknown credential id costs one signature verification, like a bad signature", () => {
  it.effect(
    "authenticate/verify for an unknown credential id still calls WebAuthn.verifyAuthentication",
    () => {
      const spy: Array<WebAuthn.VerifyAuthenticationInput> = [];
      return Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { ceremonyId, options } = yield* passkey.authenticateOptions({});
        const failure = yield* passkey
          .authenticateVerify({
            ceremonyId,
            credential: assertionCredential({ options, id: "no-such-credential" }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvalidCredentials");
        assert.strictEqual(spy.length, 1);
        // Verified against the fixed decoy key, never against a real credential's.
        assert.notStrictEqual(spy[0]?.credential.id, "no-such-credential");
      }).pipe(Effect.provide(buildLayer(mockWebAuthn({ spy: { verifyAuthentication: spy } }))));
    },
  );

  it.effect("a known credential's bad signature performs the same single verification", () => {
    const spy: Array<WebAuthn.VerifyAuthenticationInput> = [];
    return Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      yield* registerNewUser("tss004@example.com");
      const { ceremonyId, options } = yield* passkey.authenticateOptions({});
      yield* passkey
        .authenticateVerify({ ceremonyId, credential: assertionCredential({ options }) })
        .pipe(Effect.ignore);
      assert.strictEqual(spy.length, 1);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn({ spy: { verifyAuthentication: spy } }))));
  });
});

describe("WPS-005/TC-001: the anonymous ceremony is rate-limited", () => {
  const limited = buildLayer(mockWebAuthn(), undefined, { rateLimiter: realRateLimiter });

  it.effect("authenticate/options is throttled per email", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      // 10 per 15 minutes per email (a fresh IP each time, so only the email budget can trip).
      for (let attempt = 0; attempt < 10; attempt++) {
        yield* passkey.authenticateOptions({ email: "probe@example.com", ip: `10.0.0.${attempt}` });
      }
      const failure = yield* passkey
        .authenticateOptions({ email: "probe@example.com", ip: "10.0.1.1" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
      // Another email from a fresh address is unaffected.
      yield* passkey.authenticateOptions({ email: "other@example.com", ip: "10.0.1.2" });
    }).pipe(Effect.provide(limited)),
  );

  it.effect("authenticate/options is throttled per source address", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      for (let attempt = 0; attempt < 60; attempt++) {
        yield* passkey.authenticateOptions({ ip: "192.0.2.7" });
      }
      const failure = yield* passkey.authenticateOptions({ ip: "192.0.2.7" }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
      yield* passkey.authenticateOptions({ ip: "192.0.2.8" });
    }).pipe(Effect.provide(limited)),
  );

  it.effect("authenticate/verify is throttled per source address", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { ceremonyId, options } = yield* passkey.authenticateOptions({ ip: "203.0.113.1" });
      const attempt = () =>
        passkey.authenticateVerify({
          ceremonyId,
          credential: assertionCredential({ options, id: "no-such-credential" }),
          ip: "203.0.113.9",
        });
      for (let i = 0; i < 60; i++) yield* attempt().pipe(Effect.ignore);
      const failure = yield* attempt().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RateLimited");
    }).pipe(Effect.provide(limited)),
  );
});
