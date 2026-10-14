// @awthaq/test — SealedConformance
//
// Plan 05 (ADR-EA-019 decision 6): the thin wiring suite for one declared sealed column. The
// mechanism itself (every branch of `open`, the compare-and-swap, `sweep`) is proven once in
// `packages/sql/test/SealedColumn.test.ts`; this proves a plugin's records module used its
// declaration: the stored value is an envelope and never the plaintext, it opens to what was
// written, a ciphertext moved to another row does not open, an envelope under a retired key
// re-seals to the current one on read.

import { Encryption, KeyProvider } from "@awthaq/ports";
import { SealedColumn } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { TestFramework } from "./TestFramework.ts";

/** An `Encryption` whose current key a test can rotate: two known keys, `k1` then `k2`. */
const rotatingKeys = () => {
  let current = "k1";
  const material = (kid: string): KeyProvider.KeyMaterial => ({
    kid,
    key: Redacted.make(new Uint8Array(32).fill(kid === "k1" ? 11 : 22)),
  });
  const provider = KeyProvider.KeyProvider.of({
    currentKey: Effect.sync(() => material(current)),
    getKey: (kid) =>
      kid === "k1" || kid === "k2"
        ? Effect.succeed(material(kid))
        : Effect.fail(new KeyProvider.UnknownKeyId({ kid })),
  });
  return {
    rotate: () => {
      current = "k2";
    },
    layer: Encryption.layer.pipe(
      Layer.provide(Layer.succeed(KeyProvider.KeyProvider, provider)),
      Layer.provide(NodeCrypto.layer),
    ),
  };
};

export interface SealedColumnConfig<A, R> {
  readonly column: SealedColumn.Column<A>;
  /** A value to seal. */
  readonly sample: A;
  /**
   * The records layers; each needs `Encryption`, which the suite provides (with a rotatable key). `raw` and
   * `plant` reach the adapter's own storage, which differs per adapter (a SQL statement, a memory row).
   */
  readonly adapters: ReadonlyArray<{
    readonly name: string;
    readonly layer: Layer.Layer<R, unknown, Encryption.Encryption>;
    /** The stored value of the column for `rowKey`, for at-rest checks. */
    readonly raw: (rowKey: string) => Effect.Effect<string, unknown, R>;
    /** Overwrites the stored value of an existing row's column, bypassing sealing (to plant a moved or legacy envelope). */
    readonly plant: (rowKey: string, stored: string) => Effect.Effect<void, unknown, R>;
  }>;
  /** Writes `value` for `rowKey` through the records interface (creating the row). */
  readonly write: (rowKey: string, value: A) => Effect.Effect<void, unknown, R>;
  /** Reads the record's sealed value for `rowKey` through the records interface. */
  readonly read: (rowKey: string) => Effect.Effect<SealedColumn.Sealed<A>, unknown, R>;
}

export const runSealedColumnTests = <A, R>(
  framework: TestFramework,
  config: SealedColumnConfig<A, R>,
): void => {
  const { column } = config;
  const name = `${column.table}.${column.column}`;

  framework.describe(`runSealedColumnTests: ${name}`, () => {
    for (const adapter of config.adapters) {
      const label = `${adapter.name} / ${name}`;
      const run = <A2>(
        body: (
          keys: ReturnType<typeof rotatingKeys>,
        ) => Effect.Effect<A2, unknown, R | Encryption.Encryption>,
      ) => {
        const keys = rotatingKeys();
        return Effect.runPromise(
          Effect.scoped(
            body(keys).pipe(Effect.provide(Layer.provideMerge(adapter.layer, keys.layer))),
          ),
        );
      };
      const text = Schema.encodeEffect(column.schema);

      framework.it(
        `${label}: the stored value is an envelope, never the plaintext, and it opens to what was written`,
        async () => {
          const outcome = await run(() =>
            Effect.gen(function* () {
              yield* config.write("row-1", config.sample);
              const stored = yield* adapter.raw("row-1");
              const opened = yield* (yield* config.read("row-1")).open.pipe(Effect.option);
              return { stored, opened: Option.map(opened, Redacted.value) };
            }),
          );
          if (!Encryption.looksLikeEnvelope(outcome.stored)) {
            framework.fail(`${label}: the stored value is not an Encryption envelope`);
          }
          const plaintext = await Effect.runPromise(text(config.sample));
          if (outcome.stored.includes(plaintext))
            framework.fail(`${label}: the plaintext is visible at rest`);
          if (
            Option.isNone(outcome.opened) ||
            JSON.stringify(outcome.opened.value) !== JSON.stringify(config.sample)
          ) {
            framework.fail(`${label}: the value did not round-trip`);
          }
        },
      );

      framework.it(`${label}: a ciphertext moved to another row does not open`, async () => {
        const reason = await run(() =>
          Effect.gen(function* () {
            yield* config.write("row-1", config.sample);
            yield* config.write("row-2", config.sample);
            yield* adapter.plant("row-2", yield* adapter.raw("row-1"));
            return yield* (yield* config.read("row-2")).open.pipe(
              Effect.flip,
              Effect.map((unreadable) => unreadable.reason),
            );
          }),
        );
        if (reason !== "DecryptionFailed") {
          framework.fail(
            `${label}: expected DecryptionFailed for a moved ciphertext, got ${reason}`,
          );
        }
      });

      framework.it(
        `${label}: an envelope under a retired key re-seals to the current key on read`,
        async () => {
          const outcome = await run((keys) =>
            Effect.gen(function* () {
              const encryption = yield* Encryption.Encryption;
              yield* config.write("row-1", config.sample);
              const before = yield* adapter.raw("row-1");
              keys.rotate();
              yield* (yield* config.read("row-1")).open;
              const after = yield* adapter.raw("row-1");
              const decrypted = yield* encryption.decrypt(
                after,
                SealedColumn.aadOf(column, "row-1"),
              );
              return { before, after, current: Option.isNone(decrypted.staleKid) };
            }),
          );
          if (outcome.before === outcome.after)
            framework.fail(`${label}: the envelope was not re-sealed after a key rotation`);
          if (!outcome.current)
            framework.fail(`${label}: the re-sealed envelope is not on the current key`);
        },
      );
    }
  });
};
