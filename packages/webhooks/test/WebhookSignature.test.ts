// BEH-EA-258 (spec/behaviors/31-webhooks.md): the Standard-Webhooks-style signature — an independent
// oracle (`node:crypto`), the replay window, rotation overlap and tamper refusals.
import { createHmac } from "node:crypto";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as WebhookSignature from "../src/WebhookSignature.ts";

const secretBytes = Buffer.alloc(32, 7);
const secret = Redacted.make(`whsec_${secretBytes.toString("base64")}`);
const message = { id: "evt_1", timestamp: 1_700_000_000, body: '{"a":1}' };

const oracle = (key: Buffer, m: typeof message): string =>
  `v1,${createHmac("sha256", key).update(`${m.id}.${m.timestamp}.${m.body}`).digest("base64")}`;

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Crypto").Crypto>) =>
  effect.pipe(Effect.provide(NodeCrypto.layer));

describe("WebhookSignature.sign", () => {
  it.effect("matches an independent HMAC-SHA256 of `id.timestamp.body` under the decoded secret", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* WebhookSignature.sign(secret, message), oracle(secretBytes, message));
    }).pipe(run),
  );

  it.effect("generated secrets are whsec_-prefixed, 32 random bytes, and distinct", () =>
    Effect.gen(function* () {
      const a = Redacted.value(yield* WebhookSignature.generateSecret);
      const b = Redacted.value(yield* WebhookSignature.generateSecret);
      assert.match(a, /^whsec_[A-Za-z0-9+/]{43}=$/);
      assert.notStrictEqual(a, b);
    }).pipe(run),
  );

  it.effect("headersFor stamps id/timestamp and signs under every secret (rotation overlap)", () =>
    Effect.gen(function* () {
      const old = Redacted.make(`whsec_${Buffer.alloc(32, 1).toString("base64")}`);
      const headers = yield* WebhookSignature.headersFor([secret, old], message);
      assert.strictEqual(headers["webhook-id"], "evt_1");
      assert.strictEqual(headers["webhook-timestamp"], "1700000000");
      assert.strictEqual(
        headers["webhook-signature"],
        `${oracle(secretBytes, message)} ${oracle(Buffer.alloc(32, 1), message)}`,
      );
    }).pipe(run),
  );
});

describe("WebhookSignature.verify", () => {
  const headersOf = (m = message) =>
    WebhookSignature.headersFor([secret], m).pipe(Effect.map((headers) => ({ ...headers })));

  it.effect("accepts an untampered request inside the window and returns the event id", () =>
    Effect.gen(function* () {
      const id = yield* WebhookSignature.verify({
        secrets: [secret],
        headers: yield* headersOf(),
        body: message.body,
        nowSeconds: message.timestamp + 10,
      });
      assert.strictEqual(id, "evt_1");
    }).pipe(run),
  );

  it.effect("refuses a changed body, a wrong secret and a forged signature", () =>
    Effect.gen(function* () {
      const headers = yield* headersOf();
      const attempts = [
        { body: '{"a":2}', secrets: [secret], headers },
        { body: message.body, secrets: [Redacted.make("whsec_" + Buffer.alloc(32, 2).toString("base64"))], headers },
        { body: message.body, secrets: [secret], headers: { ...headers, "webhook-signature": "v1,AAAA" } },
        { body: message.body, secrets: [secret], headers: { ...headers, "webhook-id": "evt_other" } },
      ];
      for (const attempt of attempts) {
        const failure = yield* WebhookSignature.verify({
          ...attempt,
          nowSeconds: message.timestamp,
        }).pipe(Effect.flip);
        assert.strictEqual(failure.reason, "noMatchingSignature");
      }
    }).pipe(run),
  );

  it.effect("the replay window is enforced in both directions (default 5 minutes)", () =>
    Effect.gen(function* () {
      const headers = yield* headersOf();
      const at = (nowSeconds: number, tolerance?: Duration.Input) =>
        WebhookSignature.verify({
          secrets: [secret],
          headers,
          body: message.body,
          nowSeconds,
          ...(tolerance === undefined ? {} : { tolerance }),
        });
      yield* at(message.timestamp + 300);
      yield* at(message.timestamp - 300);
      const late = yield* at(message.timestamp + 301).pipe(Effect.flip);
      assert.strictEqual(late.reason, "timestampOutsideTolerance");
      const early = yield* at(message.timestamp - 301).pipe(Effect.flip);
      assert.strictEqual(early.reason, "timestampOutsideTolerance");
      // A stricter receiver narrows it.
      const strict = yield* at(message.timestamp + 61, Duration.minutes(1)).pipe(Effect.flip);
      assert.strictEqual(strict.reason, "timestampOutsideTolerance");
    }).pipe(run),
  );

  it.effect("rejects missing headers and a malformed timestamp before any MAC work", () =>
    Effect.gen(function* () {
      const headers = yield* headersOf();
      const missing = yield* WebhookSignature.verify({
        secrets: [secret],
        headers: { "webhook-id": "evt_1" },
        body: message.body,
      }).pipe(Effect.flip);
      assert.strictEqual(missing.reason, "missingHeaders");
      for (const bad of ["abc", "-1", "1.5", "99999999999999999999", ""]) {
        const failure = yield* WebhookSignature.verify({
          secrets: [secret],
          headers: { ...headers, "webhook-timestamp": bad },
          body: message.body,
        }).pipe(Effect.flip);
        assert.strictEqual(failure.reason, "malformedTimestamp", bad);
      }
    }).pipe(run),
  );

  it.effect("accepts a signature from either secret during a rotation, and ignores unknown versions", () =>
    Effect.gen(function* () {
      const old = Redacted.make(`whsec_${Buffer.alloc(32, 1).toString("base64")}`);
      // The sender signed with old and new; a receiver that only knows `old` still verifies.
      const both = yield* WebhookSignature.headersFor([secret, old], message);
      yield* WebhookSignature.verify({
        secrets: [old],
        headers: { ...both },
        body: message.body,
        nowSeconds: message.timestamp,
      });
      // A `v2,` value is not a signature this scheme defines: it is ignored, not accepted.
      const failure = yield* WebhookSignature.verify({
        secrets: [secret],
        headers: { ...both, "webhook-signature": both["webhook-signature"].replaceAll("v1,", "v2,") },
        body: message.body,
        nowSeconds: message.timestamp,
      }).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "noMatchingSignature");
    }).pipe(run),
  );
});
