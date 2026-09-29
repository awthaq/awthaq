// @awthaq/ports — PasswordHasherWorkerPool
//
// ERS-001 (decision 35). Opt-in `PasswordHasher` layers whose key derivation
// runs in a pool of worker threads, so a burst of sign-ins never blocks the
// event loop the way hash-wasm on the calling thread does. They produce and
// verify exactly the same hashes as `layerArgon2id`/`layerScrypt` (the same
// `makeArgon2id`/`makeScrypt` over a different `KdfBackend`), so a hash made by
// one verifies on the other and an application can switch by swapping one Layer.
//
//   const HasherLive = PasswordHasherWorkerPool.layerArgon2id.pipe(
//     Layer.provide(NodeWorker.layer(() => new Worker(PasswordHasherWorkerPool.workerEntry))),
//   );
//
// The application provides the worker platform (`@effect/platform-node`'s
// `NodeWorker.layer`, or Bun's/the browser's equivalent) — this package takes
// no platform dependency. The bundled entry (`passwordHasherWorker`) targets
// Node's `worker_threads`; another runtime supplies its own entry speaking the
// wire protocol documented there.
//
// `AUTH_PASSWORD_HASH_WORKER_POOL_SIZE` (default 4) workers each derive one
// hash at a time, which is also the bound on concurrent KDF work; a request
// waits for a free worker. Peak KDF memory is roughly the pool size times the
// per-hash figure documented in `PasswordHasher.ts`. Legacy verifiers (bcrypt)
// still run on the calling thread, bounded by `AUTH_PASSWORD_HASH_CONCURRENCY`.

import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Pool from "effect/Pool";
import * as Schedule from "effect/Schedule";
import * as Worker from "effect/unstable/workers/Worker";
import {
  type Argon2idJob,
  KdfFailed,
  type KdfBackend,
  makeArgon2id,
  makeScrypt,
  makeSlots,
  PasswordHasher,
  type ScryptJob,
} from "./PasswordHasher.ts";

/** What the main thread sends a worker. */
export type HasherWorkerRequest =
  | { readonly id: number; readonly kind: "argon2id"; readonly job: Argon2idJob }
  | { readonly id: number; readonly kind: "scrypt"; readonly job: ScryptJob };

/** What a worker answers with: the derived digest, or why it could not. */
export type HasherWorkerResponse =
  | { readonly id: number; readonly digest: Uint8Array }
  | { readonly id: number; readonly error: string };

/**
 * The bundled Node worker entry, resolved next to this module whether it is
 * loaded from source (`.ts`, run under Node's type stripping or Bun) or from
 * the built `lib` (`.js`).
 */
export const workerEntry: URL = new URL(
  import.meta.url.endsWith(".ts") ? "./passwordHasherWorker.ts" : "./passwordHasherWorker.js",
  import.meta.url,
);

const poolSizeConfig = Config.Int("AUTH_PASSWORD_HASH_WORKER_POOL_SIZE").pipe(
  Config.withDefault(4),
);

/**
 * A `KdfBackend` over a pool of workers built from the ambient worker
 * platform. Scoped: closing the scope asks every worker to close.
 */
export const makeBackend = Effect.gen(function* () {
  const size = yield* poolSizeConfig;
  if (size < 1) {
    return yield* Effect.die(
      new Error(`awthaq: AUTH_PASSWORD_HASH_WORKER_POOL_SIZE (${size}) must be at least 1`),
    );
  }
  const platform = yield* Worker.WorkerPlatform;
  const spawner = yield* Worker.Spawner;

  const pending = new Map<
    number,
    { readonly worker: object; readonly result: Deferred.Deferred<Uint8Array, KdfFailed> }
  >();
  let nextWorkerId = 0;
  let nextRequestId = 0;

  const failPendingOf = (worker: object, reason: string) =>
    Effect.forEach(
      [...pending].filter(([, entry]) => entry.worker === worker),
      ([id, entry]) => {
        pending.delete(id);
        return Deferred.fail(entry.result, new KdfFailed({ cause: reason }));
      },
      { discard: true },
    );

  const acquire = Effect.gen(function* () {
    const worker = yield* platform
      .spawn<HasherWorkerResponse, HasherWorkerRequest>(nextWorkerId++)
      .pipe(Effect.provideService(Worker.Spawner, spawner));
    yield* worker
      .run((response) => {
        const entry = pending.get(response.id);
        if (entry === undefined) return Effect.void;
        pending.delete(response.id);
        return "digest" in response
          ? Deferred.succeed(entry.result, response.digest)
          : Deferred.fail(entry.result, new KdfFailed({ cause: response.error }));
      })
      .pipe(
        // A worker that dies fails what it was deriving, then is respawned.
        Effect.tapCause(() => failPendingOf(worker, "password hasher worker failed")),
        Effect.retry(Schedule.spaced(1000)),
        Effect.forkScoped,
      );
    return worker;
  });

  const pool = yield* Pool.make({ acquire, size });

  const request = (
    build: (id: number) => HasherWorkerRequest,
  ): Effect.Effect<Uint8Array, KdfFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* Pool.get(pool);
        const id = nextRequestId++;
        const result = yield* Deferred.make<Uint8Array, KdfFailed>();
        pending.set(id, { worker, result });
        yield* worker.send(build(id)).pipe(
          Effect.mapError((cause) => new KdfFailed({ cause })),
          Effect.onError(() => Effect.sync(() => pending.delete(id))),
        );
        return yield* Deferred.await(result).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
      }),
    ).pipe(
      Effect.mapError((error) =>
        error instanceof KdfFailed ? error : new KdfFailed({ cause: error }),
      ),
    );

  const backend: KdfBackend = {
    argon2id: (job) => request((id) => ({ id, kind: "argon2id", job })),
    scrypt: (job) => request((id) => ({ id, kind: "scrypt", job })),
  };
  return backend;
});

type PoolRequirements = Crypto.Crypto | Worker.WorkerPlatform | Worker.Spawner;

/** argon2id with the KDF in a worker pool; see this module's header. */
export const layerArgon2id: Layer.Layer<PasswordHasher, Config.ConfigError, PoolRequirements> =
  Layer.effect(
    PasswordHasher,
    Effect.gen(function* () {
      const slots = yield* makeSlots;
      const backend = yield* makeBackend;
      return yield* makeArgon2id(backend, slots);
    }),
  );

/** scrypt with the KDF in a worker pool; see this module's header. */
export const layerScrypt: Layer.Layer<PasswordHasher, Config.ConfigError, PoolRequirements> =
  Layer.effect(
    PasswordHasher,
    Effect.gen(function* () {
      const slots = yield* makeSlots;
      const backend = yield* makeBackend;
      return yield* makeScrypt(backend, slots);
    }),
  );
