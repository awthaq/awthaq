// MLO-009/ARF-007/ARF-009: the shared, purpose-checked mailed-token codec.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";
import * as VerificationLink from "../src/VerificationLink.ts";

const TestLayer = Verification.layerMemory.pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

describe("VerificationLink.encode/decode", () => {
  const value = Redacted.make("secret-half");

  it("round-trips a token for its own purpose", () => {
    const token = VerificationLink.encode({
      purpose: "reset-password",
      publicId: "abc_-123",
      value,
    });
    const decoded = VerificationLink.decode(Redacted.value(token), "reset-password");
    assert.isTrue(Option.isSome(decoded));
    const got = Option.getOrThrow(decoded);
    assert.strictEqual(got.identifier, "reset-password:abc_-123");
    assert.strictEqual(got.publicId, "abc_-123");
    assert.strictEqual(Redacted.value(got.value), "secret-half");
  });

  it("rejects another purpose's token", () => {
    const token = VerificationLink.encode({ purpose: "verify-email", publicId: "abc", value });
    assert.isTrue(Option.isNone(VerificationLink.decode(Redacted.value(token), "reset-password")));
  });

  it("rejects malformed input: no separator, empty halves, purpose-only identifier", () => {
    for (const raw of [
      "",
      "nodot",
      ".secret",
      "reset-password:abc.",
      "reset-password:.secret",
      "abc.secret",
    ]) {
      assert.isTrue(Option.isNone(VerificationLink.decode(raw, "reset-password")), raw);
    }
  });

  it("does not print the token", () => {
    const token = VerificationLink.encode({ purpose: "verify-email", publicId: "abc", value });
    assert.notInclude(String(token), "secret-half");
  });
});

describe("VerificationLink.issue", () => {
  it.effect("mints an opaque id: the token carries no user id, and the row keeps it", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const crypto = yield* Crypto.Crypto;
      const userId = Users.UserId("11111111-1111-7111-8111-111111111111");
      const issued = yield* VerificationLink.issue(
        { verification, crypto },
        { purpose: "reset-password", ttl: Duration.hours(1), userId },
      );
      assert.notInclude(Redacted.value(issued.token), userId);
      const decoded = Option.getOrThrow(
        VerificationLink.decode(Redacted.value(issued.token), "reset-password"),
      );
      const consumed = yield* verification.consume(decoded.identifier, decoded.value);
      assert.deepStrictEqual(consumed.userId, Option.some(userId));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("two tokens for the same user get distinct public ids", () =>
    Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const crypto = yield* Crypto.Crypto;
      const input = { purpose: "verify-email", ttl: Duration.hours(1) };
      const a = yield* VerificationLink.issue({ verification, crypto }, input);
      const b = yield* VerificationLink.issue({ verification, crypto }, input);
      assert.notStrictEqual(a.publicId, b.publicId);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("VerificationLink.mailData", () => {
  it.effect(
    "always carries expiresAt, keeps the token Redacted, adds url only when configured",
    () =>
      Effect.gen(function* () {
        const expiresAt = yield* DateTime.now;
        const token = Redacted.make("t.o.k");
        const plain = VerificationLink.mailData({ token, expiresAt });
        assert.strictEqual(plain.expiresAt, DateTime.formatIso(expiresAt));
        assert.isTrue(Redacted.isRedacted(plain.token));
        assert.isUndefined(plain.url);
        const linked = VerificationLink.mailData({
          token,
          expiresAt,
          link: (raw) => `https://app.example/reset#${raw}`,
        });
        assert.strictEqual(linked.url, "https://app.example/reset#t.o.k");
      }),
  );
});
