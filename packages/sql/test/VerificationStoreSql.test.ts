// Plan 02, phase 3: what only the SQL adapter of `VerificationStore` can show. What every adapter
// must do is `StoreContract.verification` (`packages/test/test/StoreContract.*.test.ts`, also on
// Postgres under `pnpm test:pg`); this is the failure mapping and the row a miss is charged to.
import { Hmac, VerificationStore } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import * as VerificationStoreSql from "../src/VerificationStoreSql.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);
const tokenId = Schema.decodeUnknownSync(Models.VerificationTokenId);

const newToken = (id: string, identifier: string, valueHash: string, maxAttempts?: number) => ({
  id: tokenId(id),
  identifier,
  userId: Option.none<Models.UserId>(),
  valueHash,
  createdAt: at(0),
  expiresAt: at(10),
  payloadJson: Option.none<string>(),
  maxAttempts: Option.fromNullishOr(maxAttempts),
});

const outage = () =>
  new SqlError({ reason: new UnknownError({ cause: new Error("database is down") }) });

describe("VerificationStoreSql failure mapping (MA-004)", () => {
  const DownTokens = Layer.effect(
    Repositories.VerificationRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.VerificationRepository;
      return {
        ...real,
        upsertLive: () => Effect.fail(outage()),
        findByIdentifier: () => Effect.fail(outage()),
        deleteAllByUser: () => Effect.fail(outage()),
        deleteExpiredBefore: () => Effect.fail(outage()),
      };
    }),
  ).pipe(Layer.provide(Repositories.VerificationRepositoryLive));

  const DownReservations = Layer.effect(
    Repositories.VerificationReservationsRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.VerificationReservationsRepository;
      return { ...real, claim: () => Effect.fail(outage()) };
    }),
  ).pipe(Layer.provide(Repositories.VerificationReservationsRepositoryLive));

  const DownStore = VerificationStoreSql.layer.pipe(
    Layer.provide(DownTokens),
    Layer.provide(DownReservations),
    Layer.provide(SqlLive),
    Layer.provide(Migrated),
  );

  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      const failures = {
        upsertLive: yield* store.upsertLive(newToken("t1", "x", "h")).pipe(Effect.flip),
        present: yield* store
          .present({ identifier: "x", valueHash: "h", now: at(1), hold: false })
          .pipe(Effect.flip),
        reserve: yield* store
          .reserve({ identifier: "x", now: at(0), expiresAt: at(1) })
          .pipe(Effect.flip),
        deleteByUser: yield* store
          .deleteByUser(Schema.decodeUnknownSync(Models.UserId)("u1"))
          .pipe(Effect.flip),
        purgeExpired: yield* store.purgeExpired(at(100)).pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `VerificationStore.${primitive}`);
      }
    }).pipe(Effect.provide(DownStore)),
  );
});

// SOS-004: a miss is charged to the row it was judged against. A reissue replaces the live row (and
// its id) while the miss sits between its claim and its spend; the spend finds nothing of the old
// row and must not touch the new token.
describe("VerificationStoreSql misses (SOS-004)", () => {
  const identifier = "email-otp:reissue-race@example.com";

  /** Reissues the identifier, once, right after a claim attempt missed, before the spend lands. */
  const state = { reissued: false };
  const ReissuingTokens = Layer.effect(
    Repositories.VerificationRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.VerificationRepository;
      const crypto = yield* Crypto.Crypto;
      return {
        ...real,
        tryConsume: (input: Parameters<typeof real.tryConsume>[0]) =>
          real.tryConsume(input).pipe(
            Effect.tap((claimed) =>
              Option.isSome(claimed) || state.reissued
                ? Effect.void
                : Effect.gen(function* () {
                    state.reissued = true;
                    const hash = yield* crypto
                      .digest("SHA-256", new TextEncoder().encode("654321"))
                      .pipe(
                        Effect.map((bytes) => Hmac.toHex(bytes)),
                        Effect.orDie,
                      );
                    yield* real
                      .upsertLive({
                        id: tokenId("reissued"),
                        identifier,
                        userId: null,
                        valueHash: hash,
                        expiresAt: at(20),
                        createdAt: at(1),
                        payload: "null",
                        maxAttempts: 2,
                        attempts: 0,
                      })
                      .pipe(Effect.orDie);
                  }),
            ),
          ),
      };
    }),
  ).pipe(Layer.provide(Repositories.VerificationRepositoryLive), Layer.provide(NodeCrypto.layer));

  const RacingStore = VerificationStoreSql.layer.pipe(
    Layer.provide(ReissuingTokens),
    Layer.provide(Repositories.VerificationReservationsRepositoryLive),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  it.effect("a reissue racing a miss never charges the new token", () =>
    Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("original", identifier, "h-original", 2));
      // One wrong guess: it misses, and the reissue lands before the spend.
      const missed = yield* store.present({
        identifier,
        valueHash: "000000",
        now: at(1),
        hold: false,
      });
      assert.strictEqual(missed._tag, "Miss");
      // The reissued token (budget 2) was not charged for it: one more wrong guess still leaves it
      // usable, and the digest of 654321 claims it.
      const hash = yield* Effect.flatMap(Crypto.Crypto, (crypto) =>
        crypto.digest("SHA-256", new TextEncoder().encode("654321")),
      ).pipe(Effect.map((bytes) => Hmac.toHex(bytes)));
      const second = yield* store.present({
        identifier,
        valueHash: "111111",
        now: at(2),
        hold: false,
      });
      assert.strictEqual(second._tag, "Miss");
      const claimed = yield* store.present({
        identifier,
        valueHash: hash,
        now: at(3),
        hold: false,
      });
      assert.strictEqual(claimed._tag, "Hit");
    }).pipe(Effect.provide(Layer.mergeAll(RacingStore, NodeCrypto.layer))),
  );
});
