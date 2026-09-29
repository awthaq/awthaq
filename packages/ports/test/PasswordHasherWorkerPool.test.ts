// ERS-001: the opt-in worker-pool hashers interoperate with the calling-thread ones.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeWorker from "@effect/platform-node/NodeWorker";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Worker } from "node:worker_threads";
import * as PasswordHasher from "../src/PasswordHasher.ts";
import * as PasswordHasherWorkerPool from "../src/PasswordHasherWorkerPool.ts";

const WorkersLive = NodeWorker.layer(() => new Worker(PasswordHasherWorkerPool.workerEntry));

const withEnv = (env: Record<string, string>) =>
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const pooled = (
  make: typeof PasswordHasherWorkerPool.layerArgon2id,
  env: Record<string, string> = { AUTH_PASSWORD_HASH_WORKER_POOL_SIZE: "2" },
) => make.pipe(Layer.provide(WorkersLive), Layer.provide(NodeCrypto.layer), withEnv(env));

const local = (make: typeof PasswordHasher.layerArgon2id) =>
  make.pipe(Layer.provide(NodeCrypto.layer));

const pw = Redacted.make("correct horse battery staple");

const suite = (
  name: string,
  makePooled: typeof PasswordHasherWorkerPool.layerArgon2id,
  makeLocal: typeof PasswordHasher.layerArgon2id,
) =>
  describe(name, () => {
    it.effect("a hash produced in the worker pool verifies on the calling-thread layer", () =>
      Effect.gen(function* () {
        const phc = yield* Effect.provide(
          Effect.flatMap(PasswordHasher.PasswordHasher, (hasher) => hasher.hash(pw)),
          pooled(makePooled),
        );
        const verified = yield* Effect.provide(
          Effect.flatMap(PasswordHasher.PasswordHasher, (hasher) => hasher.verify(pw, phc)),
          local(makeLocal),
        );
        assert.isTrue(verified);
      }),
    );

    it.effect("and a calling-thread hash verifies in the worker pool", () =>
      Effect.gen(function* () {
        const phc = yield* Effect.provide(
          Effect.flatMap(PasswordHasher.PasswordHasher, (hasher) => hasher.hash(pw)),
          local(makeLocal),
        );
        const outcomes = yield* Effect.provide(
          Effect.flatMap(PasswordHasher.PasswordHasher, (hasher) =>
            Effect.all(
              [
                hasher.verify(pw, phc),
                hasher.verify(Redacted.make("wrong password"), phc),
                hasher.verify(pw, phc),
              ],
              { concurrency: "unbounded" },
            ),
          ),
          pooled(makePooled, { AUTH_PASSWORD_HASH_WORKER_POOL_SIZE: "1" }),
        );
        assert.deepStrictEqual(outcomes, [true, false, true]);
      }),
    );
  });

suite(
  "PasswordHasherWorkerPool.layerArgon2id",
  PasswordHasherWorkerPool.layerArgon2id,
  PasswordHasher.layerArgon2id,
);
suite(
  "PasswordHasherWorkerPool.layerScrypt",
  PasswordHasherWorkerPool.layerScrypt,
  PasswordHasher.layerScrypt,
);

describe("PasswordHasherWorkerPool configuration", () => {
  it.effect("a pool size below one fails the layer", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(
          PasswordHasher.PasswordHasher.use((hasher) => Effect.succeed(hasher)),
          pooled(PasswordHasherWorkerPool.layerArgon2id, {
            AUTH_PASSWORD_HASH_WORKER_POOL_SIZE: "0",
          }),
        ),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );
});
