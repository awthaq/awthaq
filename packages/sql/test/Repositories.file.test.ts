// SEA-004: production SQLite is a file in WAL mode, but every other SQLite
// test runs `:memory:` (where `PRAGMA journal_mode = WAL` is a no-op). This
// suite runs the shared contract cases against a temp-file database, then
// proves the two compare-and-swap primitives (`Sessions.touch`,
// `VerificationReservations.claim`) are atomic across two independent
// connections on the same WAL file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Model from "effect/unstable/schema/Model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import { contractCases, repositoriesLayer } from "./contract.ts";

const M = Models.makeModels("sqlite");

/** A fresh database file per layer build, removed when the layer's scope closes. */
const tempDatabaseFile = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-sql-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => join(dir, "auth.db")));

const FileLive = Layer.unwrap(
  Effect.map(tempDatabaseFile, (filename) => SqliteClient.layer({ filename })),
);

contractCases("Repositories (file-backed WAL)", "sqlite", repositoriesLayer(FileLive));

describe("SQLite file database (SEA-004)", () => {
  it.effect("journal_mode is wal on a file-backed database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
      assert.strictEqual(rows[0]?.journal_mode, "wal");
    }).pipe(Effect.provide(repositoriesLayer(FileLive))),
  );

  // Two independent `SqliteClient`s (two connections) on one file. The first
  // runs the migrations; both then race the same CAS statements.
  const twoConnections = Effect.gen(function* () {
    const filename = yield* tempDatabaseFile;
    const first = yield* Layer.build(repositoriesLayer(SqliteClient.layer({ filename })));
    const second = yield* Layer.build(
      Layer.mergeAll(
        Repositories.UsersRepositoryLive,
        Repositories.SessionsRepositoryLive,
        Repositories.VerificationReservationsRepositoryLive,
      ).pipe(Layer.provideMerge(SqliteClient.layer({ filename }))),
    );
    return { first, second };
  });

  it.effect("two connections racing touch: exactly one rotates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { first, second } = yield* twoConnections;
        const users = Context.get(first, Repositories.UsersRepository);
        const sessionsA = Context.get(first, Repositories.SessionsRepository);
        const sessionsB = Context.get(second, Repositories.SessionsRepository);
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "wal-touch@example.com", name: "W" }),
        );
        const now = yield* DateTime.now;
        const session = yield* sessionsA.insert(
          M.Session.insert.make({
            userId: user.id,
            secretHash: "original",
            ipAddress: null,
            userAgent: null,
            absoluteExpiresAt: now,
            idleExpiresAt: Model.Override(now),
            actingAsType: null,
            actingAsId: null,
            familyId: Schema.decodeUnknownSync(Models.SessionId)("wal-family"),
            supersededBy: null,
            supersededAt: null,
            reusedAt: null,
          }),
        );
        const rotate = (repo: Repositories.SessionsRepositoryShape, secretHash: string) =>
          repo.touch({
            id: session.id,
            expectedSecretHash: "original",
            secretHash,
            lastActiveAt: now,
            idleExpiresAt: now,
          });
        const results = yield* Effect.all(
          [rotate(sessionsA, "from-a"), rotate(sessionsB, "from-b")],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter(Option.isSome).length, 1);
        // Both connections agree on the winner (WAL commit visible across connections).
        const winner = results.find(Option.isSome);
        const readByB = yield* sessionsB.findById(session.id);
        assert.strictEqual(readByB.secretHash, winner?.value.secretHash);
      }),
    ),
  );

  it.effect("two connections racing claim: exactly one wins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { first, second } = yield* twoConnections;
        const a = Context.get(first, Repositories.VerificationReservationsRepository);
        const b = Context.get(second, Repositories.VerificationReservationsRepository);
        const now = yield* DateTime.now;
        const claim = (repo: Repositories.VerificationReservationsRepositoryShape) =>
          repo.claim({
            identifier: "wal-claim",
            expiresAt: DateTime.addDuration(now, Duration.minutes(1)),
            now,
          });
        const results = yield* Effect.all([claim(a), claim(b)], { concurrency: "unbounded" });
        assert.strictEqual(results.filter((won) => won).length, 1);
      }),
    ),
  );
});
