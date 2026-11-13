import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as SecretHash from "../src/SecretHash.ts";

const inputs = [
  "a".repeat(32) + "0123456789abcdef".repeat(2),
  "",
  "pässwörd-ключ-🔑",
  `scim_${"ab".repeat(32)}`,
  "BCDFGHJK",
];
const oracle = (input: string) => createHash("sha256").update(input, "utf8").digest("hex");
const run = <A>(f: (hasher: Digest.Digest["Service"]) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    return yield* f(yield* Digest.Digest);
  }).pipe(Effect.provide(NodeCrypto.layer));

describe("SecretHash", () => {
  it.effect("matches the FIPS 180-2 vector for abc", () =>
    run((hasher) => SecretHash.digest(hasher, "abc")).pipe(
      Effect.map((d) =>
        assert.strictEqual(d, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
      ),
    ),
  );

  it.effect("equals Node's createHash sha256 lower-case hex for every input", () =>
    run((hasher) => Effect.forEach(inputs, (i) => SecretHash.digest(hasher, i))).pipe(
      Effect.map((digests) => {
        digests.forEach((d, n) => assert.strictEqual(d, oracle(inputs[n]!)));
      }),
    ),
  );

  it.effect("is 64 lower-case hex characters", () =>
    run((hasher) => Effect.forEach(inputs, (i) => SecretHash.digest(hasher, i))).pipe(
      Effect.map((digests) => {
        for (const d of digests) assert.match(d, /^[0-9a-f]{64}$/);
      }),
    ),
  );

  it.effect("NEVER_MATCHES is 64 characters and equals no digest", () =>
    run((hasher) => Effect.forEach(inputs, (i) => SecretHash.digest(hasher, i))).pipe(
      Effect.map((digests) => {
        assert.strictEqual(SecretHash.NEVER_MATCHES.length, 64);
        for (const d of digests) assert.isFalse(SecretHash.equals(d, SecretHash.NEVER_MATCHES));
      }),
    ),
  );

  it.effect("equals is true for the same digest and false for one changed character", () =>
    run((hasher) => SecretHash.digest(hasher, "abc")).pipe(
      Effect.map((d) => {
        assert.isTrue(SecretHash.equals(d, d));
        const changed = d.slice(0, -1) + (d.endsWith("0") ? "1" : "0");
        assert.isFalse(SecretHash.equals(d, changed));
      }),
    ),
  );
});
