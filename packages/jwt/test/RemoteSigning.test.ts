// .scratch/jwt/issues/15-remote-signing-swap.md — a fake/test remote
// signer (an in-memory `Map<kid, CryptoKeyPair>`), swapped in via
// `JwtCodec.RemoteSigner`, signs and verifies a token end to end through
// the exact same `JwtCodec.verify` path a locally-signed token goes
// through — no special-casing. Also confirms `SigningKeyRecords` never
// gets `privateKeyJwk` populated for a remote-backed key.
import { SqlTransaction } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as JwtCodec from "../src/JwtCodec.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

/** A fake KMS: generates its own local keypair (so the test can sign for real) but exposes only the `JwtCodec.Signer` boundary — the plugin never touches its private half. */
const makeFakeRemoteSigner = () =>
  Effect.gen(function* () {
    const keyPair = yield* Effect.tryPromise(() =>
      globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
    );
    const rawPublicKeyJwk = yield* Effect.tryPromise(() =>
      globalThis.crypto.subtle.exportKey("jwk", keyPair.publicKey),
    );
    const publicKeyJwk = { ...rawPublicKeyJwk };

    const signer: JwtCodec.Signer = {
      sign: ({ signingInput }) =>
        Effect.tryPromise({
          try: async () => {
            const signature = await globalThis.crypto.subtle.sign(
              { name: "Ed25519" },
              keyPair.privateKey,
              signingInput,
            );
            return new Uint8Array(signature);
          },
          catch: (cause) => new JwtCodec.JwtInvalidError({ reason: `fake KMS failure: ${cause}` }),
        }),
    };

    return { signer, publicKeyJwk };
  });

describe("remote signing", () => {
  it.effect(
    "a remote-signed token verifies identically to a locally-signed one, via the shared verify path",
    () =>
      Effect.gen(function* () {
        const kid = "remote-key-1";
        const { signer, publicKeyJwk } = yield* makeFakeRemoteSigner();

        const token = yield* JwtCodec.sign({
          kid,
          alg: "EdDSA",
          typ: "at+jwt",
          signer,
          claims: {
            sub: "user-1",
            iat: 0,
            exp: 999_999_999,
            iss: "https://issuer.test",
            aud: "https://issuer.test",
          },
        });

        const claims = yield* JwtCodec.verify({
          token,
          keys: [{ kid, alg: "EdDSA", publicKeyJwk }],
          algorithms: ["EdDSA"],
          expectedTyp: "at+jwt",
          issuer: "https://issuer.test",
          audience: "https://issuer.test",
        });

        assert.strictEqual(claims["sub"], "user-1");
      }),
  );

  it.effect(
    "KeyRing.registerRemoteKey never populates privateKeyJwk, and the key is immediately current/verifiable",
    () =>
      Effect.gen(function* () {
        const { publicKeyJwk } = yield* makeFakeRemoteSigner();

        yield* KeyRing.registerRemoteKey({ kid: "remote-key-2", alg: "EdDSA", publicKeyJwk });

        const records = yield* SigningKeyRecords.SigningKeyRecords;
        const stored = yield* records.findCurrent();
        assert.isTrue(Option.isSome(stored));
        assert.strictEqual(Option.getOrThrow(stored).kid, "remote-key-2");
        assert.isTrue(Option.isNone(Option.getOrThrow(stored).privateKeyJwk));

        const current = yield* KeyRing.current;
        assert.strictEqual(current.kid, "remote-key-2");
        assert.isTrue(Option.isNone(current.privateKeyJwk));
      }).pipe(
        Effect.provide(
          KeyRing.KeyRing.layer.pipe(
            // `registerRemoteKey` runs before `KeyRing` is ever accessed,
            // so `layerFromStore` finds it via `findCurrent()` directly —
            // no `mint` call on this path — but `Crypto`/`JwtConfig` are
            // still part of `layerFromStore`'s own *declared* R (Effect's
            // R is the static union across every branch, not just the one
            // actually taken), so both still need providing here.
            Layer.provideMerge(SigningKeyRecords.layerMemory),
            Layer.provideMerge(SqlTransaction.layerNoop),
            Layer.provideMerge(JwtConfig.config({ issuer: "https://issuer.test" })),
            Layer.provideMerge(NodeCrypto.layer),
          ),
        ),
      ),
  );
});
