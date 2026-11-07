// SEA-004 (plan 16): production SQLite is a file in WAL mode, but most SQLite tests run `:memory:`
// (where `PRAGMA journal_mode = WAL` is a no-op). `StoreContract` runs on a WAL file too
// (`StoreContract.file.test.ts`); this suite proves the two compare-and-swap primitives
// (`SessionStore.rotate`, `VerificationStore.reserve`) are atomic across two independent connections
// on the same file, over two builds of the whole bundle.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encryption, KeyProvider, SessionStore, VerificationStore } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as CoreStoresSql from "../src/CoreStoresSql.ts";
import * as Models from "../src/Models.ts";

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** A fresh database file per layer build, removed when the layer's scope closes. */
const tempDatabaseFile = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-sql-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => join(dir, "auth.db")));

/** The bundle over one connection to `filename`; `migrate` runs the core migrations first. */
const bundleOver = (filename: string, migrate: boolean) => {
  const client = SqliteClient.layer({ filename });
  const migrated = migrate
    ? Layer.effectDiscard(Migrator.make({})({ loader: CoreMigrations.coreMigrations })).pipe(
        Layer.provide(client),
      )
    : Layer.empty;
  return CoreStoresSql.layer().pipe(
    Layer.provide(EncryptionLive),
    Layer.provideMerge(client),
    Layer.provideMerge(migrated),
  );
};

const sessionId = Schema.decodeUnknownSync(Models.SessionId);
const userId = Schema.decodeUnknownSync(Models.UserId);

describe("SQLite on a WAL file (SEA-004)", () => {
  it.effect("journal_mode is wal on a file-backed database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const filename = yield* tempDatabaseFile;
        const context = yield* Layer.build(bundleOver(filename, true));
        const sql = Context.get(context, SqlClient.SqlClient);
        const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
        assert.strictEqual(rows[0]?.journal_mode, "wal");
      }),
    ),
  );

  // Two independent `SqliteClient`s (two connections) on one file. The first runs the migrations;
  // both then race the same compare-and-swap statements.
  const twoConnections = Effect.gen(function* () {
    const filename = yield* tempDatabaseFile;
    const first = yield* Layer.build(bundleOver(filename, true));
    const second = yield* Layer.build(bundleOver(filename, false));
    return { first, second };
  });

  it.effect("two connections racing rotate: exactly one rotates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { first, second } = yield* twoConnections;
        const a = Context.get(first, SessionStore.SessionStore);
        const b = Context.get(second, SessionStore.SessionStore);
        const now = yield* DateTime.now;
        const later = DateTime.add(now, { hours: 1 });
        yield* a.insert({
          session: {
            id: sessionId("wal-session"),
            userId: userId("wal-user"),
            secretHash: "original",
            at: now,
            absoluteExpiresAt: later,
            idleExpiresAt: later,
            ipAddress: Option.none(),
            userAgent: Option.none(),
            actingAs: Option.none(),
            amr: [],
          },
          supersedes: Option.none(),
          maxLive: Option.none(),
        });
        const rotate = (store: SessionStore.SessionStoreShape, secretHash: string) =>
          store.rotate({
            id: sessionId("wal-session"),
            expectedSecretHash: "original",
            secretHash,
            previous: Option.none(),
            lastActiveAt: now,
            idleExpiresAt: later,
          });
        const results = yield* Effect.all([rotate(a, "from-a"), rotate(b, "from-b")], {
          concurrency: "unbounded",
        });
        assert.strictEqual(results.filter((outcome) => outcome._tag === "Rotated").length, 1);
        // Both connections agree on the winner (WAL commit visible across connections).
        const winner = results.find((outcome) => outcome._tag === "Rotated");
        const readByB = Option.getOrThrow(yield* b.get(sessionId("wal-session")));
        assert.strictEqual(
          readByB.secretHash,
          winner?._tag === "Rotated" ? winner.session.secretHash : undefined,
        );
      }),
    ),
  );

  it.effect("two connections racing reserve: exactly one wins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { first, second } = yield* twoConnections;
        const a = Context.get(first, VerificationStore.VerificationStore);
        const b = Context.get(second, VerificationStore.VerificationStore);
        const now = yield* DateTime.now;
        const reserve = (store: VerificationStore.VerificationStoreShape) =>
          store.reserve({
            identifier: "wal-claim",
            expiresAt: DateTime.addDuration(now, Duration.minutes(1)),
            now,
          });
        const results = yield* Effect.all([reserve(a), reserve(b)], { concurrency: "unbounded" });
        assert.strictEqual(results.filter((won) => won).length, 1);
      }),
    ),
  );
});
