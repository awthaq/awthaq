// ERS-001: bounded KDF concurrency on the calling-thread layers, and that the
// hand-encoded PHC strings match hash-wasm's own encoding byte for byte.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { argon2id, scrypt } from "hash-wasm";
import * as PasswordHasher from "../src/PasswordHasher.ts";

const withEnv = (env: Record<string, string>) =>
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

describe("calling-thread hashers bound their concurrency (ERS-001)", () => {
  // A legacy verifier that records how many verifies overlap and parks until released:
  // it stands in for bcrypt, which the same permits must bound.
  const overlapProbe = Effect.gen(function* () {
    const inFlight = yield* Ref.make(0);
    const peak = yield* Ref.make(0);
    const release = yield* Deferred.make<void>();
    const verifier: PasswordHasher.LegacyPasswordVerifierShape = {
      id: "probe",
      recognizes: (phc) => phc.startsWith("$probe$"),
      verify: () =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
          yield* Ref.update(peak, (p) => Math.max(p, now));
          yield* Deferred.await(release);
          yield* Ref.update(inFlight, (n) => n - 1);
          return true;
        }),
    };
    return { verifier, peak, release };
  });

  const racing = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const { verifier, peak, release } = yield* overlapProbe;
      return yield* Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const fibers = yield* Effect.forEach([1, 2, 3], () =>
          Effect.forkChild(hasher.verify(Redacted.make("pw"), "$probe$x"), {
            startImmediately: true,
          }),
        );
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        const observed = yield* Ref.get(peak);
        // Release everyone, however many are running or waiting.
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join);
        return observed;
      }).pipe(
        Effect.provide(
          PasswordHasher.layerArgon2id.pipe(Layer.provide(NodeCrypto.layer), withEnv(env)),
        ),
        Effect.provideService(PasswordHasher.LegacyPasswordVerifiers, [verifier]),
      );
    });

  it.effect("with AUTH_PASSWORD_HASH_CONCURRENCY=1 at most one verify runs at a time", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* racing({ AUTH_PASSWORD_HASH_CONCURRENCY: "1" }), 1);
    }),
  );

  it.effect("the default admits a small bounded number", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* racing({}), 3);
    }),
  );

  it.effect("a non-positive concurrency fails the layer at build time", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(
          PasswordHasher.PasswordHasher.use((hasher) => Effect.succeed(hasher)),
          PasswordHasher.layerArgon2id.pipe(
            Layer.provide(NodeCrypto.layer),
            withEnv({ AUTH_PASSWORD_HASH_CONCURRENCY: "0" }),
          ),
        ),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );
});

describe("hand-encoded PHC output matches hash-wasm's own encoding", () => {
  it.effect("argon2id: a hash verifies under hash-wasm's independent computation", () =>
    Effect.gen(function* () {
      const hasher = yield* PasswordHasher.PasswordHasher;
      const phc = yield* hasher.hash(Redacted.make("correct horse battery staple"));
      // `argon2Verify` is used here only as an independent oracle in the test.
      const { argon2Verify } = yield* Effect.promise(() => import("hash-wasm"));
      assert.isTrue(
        yield* Effect.promise(() =>
          argon2Verify({ password: "correct horse battery staple", hash: phc }),
        ),
      );
    }).pipe(Effect.provide(PasswordHasher.layerArgon2id.pipe(Layer.provide(NodeCrypto.layer)))),
  );

  it.effect(
    "argon2id: the encoded string equals hash-wasm's for the same salt and parameters",
    () =>
      Effect.gen(function* () {
        const salt = new Uint8Array(16).fill(9);
        const encoded = yield* Effect.promise(() =>
          argon2id({
            password: "pw",
            salt,
            iterations: 2,
            parallelism: 1,
            memorySize: 19_456,
            hashLength: 32,
            outputType: "encoded",
          }),
        );
        const hasher = yield* PasswordHasher.PasswordHasher;
        assert.isTrue(yield* hasher.verify(Redacted.make("pw"), encoded));
        assert.isFalse(hasher.needsRehash(encoded));
      }).pipe(Effect.provide(PasswordHasher.layerArgon2id.pipe(Layer.provide(NodeCrypto.layer)))),
  );

  it.effect("scrypt: a hash verifies against hash-wasm's independent hex digest", () =>
    Effect.gen(function* () {
      const hasher = yield* PasswordHasher.PasswordHasher;
      const phc = yield* hasher.hash(Redacted.make("pw"));
      const match = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([0-9a-f]+)$/.exec(phc);
      assert.isNotNull(match);
      const [, ln, r, p, saltB64, hex] = match ?? [];
      const salt = Uint8Array.from(atob(saltB64 ?? ""), (c) => c.charCodeAt(0));
      const expected = yield* Effect.promise(() =>
        scrypt({
          password: "pw",
          salt,
          costFactor: 2 ** Number(ln),
          blockSize: Number(r),
          parallelism: Number(p),
          hashLength: 32,
          outputType: "hex",
        }),
      );
      assert.strictEqual(hex, expected);
    }).pipe(Effect.provide(PasswordHasher.layerScrypt.pipe(Layer.provide(NodeCrypto.layer)))),
  );
});
