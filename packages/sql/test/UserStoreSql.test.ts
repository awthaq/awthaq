// Plan 02 / plan 16: what only the SQL adapter of `UserStore` can show. What every adapter must do is
// `StoreContract.users` (`packages/test/test/StoreContract.*.test.ts`, also on Postgres under
// `pnpm test:pg`); the sealed metadata column is `CoreSealedColumns.test.ts` and `PiiEncryption.test.ts`.
// This is the holder that vanished between the two statements of an insert, a key that never frees up,
// a unique violation inside an enclosing transaction, the statements a primitive sends, and the
// failure mapping (injected at the SQL client, `FaultySql`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encryption, KeyProvider, Sealed, SqlTransaction, UserStore } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { UnknownError } from "effect/unstable/sql/SqlError";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as UserStoreSql from "../src/UserStoreSql.ts";
import * as FaultySql from "./support/FaultySql.ts";

const migrate = Migrator.make({})({ loader: CoreMigrations.coreMigrations });
const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(migrate).pipe(Layer.provide(SqlLive));

/** The store over a client whose statements fail on demand (`FaultySql`), after the schema is applied. */
const FaultyStore = (() => {
  const Faulty = FaultySql.layer(SqliteClient.layer({ filename: ":memory:" }));
  return UserStoreSql.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(migrate).pipe(Layer.provide(Faulty))),
    Layer.provideMerge(Faulty),
  );
})();

const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);
const userId = Schema.decodeUnknownSync(Models.UserId);

const newUser = (id: string, email?: string, metadata?: string): UserStore.NewUser => ({
  id: userId(id),
  email: Option.fromNullishOr(email),
  emailVerified: false,
  phone: Option.none(),
  phoneVerified: false,
  name: id,
  image: Option.none(),
  metadata: Option.fromNullishOr(metadata),
  status: "active",
  statusReason: Option.none(),
  suspendedUntil: Option.none(),
  createdAt: at(0),
  updatedAt: at(0),
});

const Plain = UserStoreSql.layer.pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

describe("UserStoreSql insertOrHolder", () => {
  // A holder deleted between the two statements: the first insert finds a conflict, the holder read
  // finds nothing (a second connection removed the holder just before it), and the insert is simply
  // tried again (it is never a defect).
  it.effect("retries the insert when the holder it lost to has vanished", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-users-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const filename = join(dir, "auth.db");
        const Faulty = FaultySql.layer(SqliteClient.layer({ filename }));
        const first = yield* Layer.build(
          UserStoreSql.layer.pipe(
            Layer.provideMerge(Layer.effectDiscard(migrate).pipe(Layer.provide(Faulty))),
            Layer.provideMerge(Faulty),
          ),
        );
        const store = Context.get(first, UserStore.UserStore);
        const faults = Context.get(first, FaultySql.FaultControl);
        const rival = yield* Layer.build(SqliteClient.layer({ filename }));
        const rivalSql = Context.get(rival, SqlClient.SqlClient);

        yield* store.insertOrHolder(newUser("holder", "a@example.com"));
        yield* faults.reset;
        yield* faults.beforeNext({
          matching: /lower\(email\)/,
          run: rivalSql`DELETE FROM users WHERE id = ${"holder"}`.pipe(Effect.orDie, Effect.asVoid),
        });
        const outcome = yield* store.insertOrHolder(newUser("u1", "a@example.com"));
        assert.strictEqual(outcome._tag, "Inserted");
        assert.strictEqual(yield* faults.attempts(/INSERT INTO users/), 2);
      }),
    ),
  );

  // The insert conflicts on the phone, but the holder is looked up by the email, which nobody holds:
  // the key never frees up, so the bounded retries end in `StoreUnavailable`, not a defect.
  it.effect("is StoreUnavailable, not a defect, when the key never frees up", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const phone = Schema.decodeUnknownSync(Models.E164)("+14155550100");
      yield* store.insertOrHolder({ ...newUser("u0"), phone: Option.some(phone) });
      const failure = yield* store
        .insertOrHolder({ ...newUser("u1", "a@example.com"), phone: Option.some(phone) })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(failure.operation, "UserStore.insertOrHolder");
    }).pipe(Effect.provide(Plain)),
  );

  // BEH-EA-041 (moved from the repository contract): the lookup folds the parameter, the unique index
  // is on `lower(email)`, so a mixed-case stored address (an import) is still found and still holds.
  it.effect("a mixed-case stored address is found by its lowercased form and holds the key", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO users (id, email, name, "emailVerified", "phoneVerified", status, "createdAt", "updatedAt")
        VALUES (${"imported"}, ${"Mixed@Example.com"}, ${"I"}, 0, 0, ${"active"}, ${"2026-01-01T00:00:00.000Z"}, ${"2026-01-01T00:00:00.000Z"})`;
      const found = yield* store.getByEmail("mixed@example.com");
      assert.strictEqual(Option.getOrThrow(found).id, "imported");
      const outcome = yield* store.insertOrHolder(newUser("u1", "mixed@example.com"));
      assert.strictEqual(outcome._tag, "Held");
    }).pipe(Effect.provide(Plain)),
  );
});

describe("UserStoreSql metadata at rest (CSG-006)", () => {
  const rawMetadata = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly metadata: string | null }>`
        SELECT metadata FROM users WHERE id = ${id}`;
      return rows[0]?.metadata;
    });

  const SealedStore = UserStoreSql.layerSealedPii.pipe(
    Layer.provide(
      Encryption.layer.pipe(
        Layer.provide(
          KeyProvider.layerEnv.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
                }),
              ),
            ),
          ),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  it.effect("layer stores metadata as given and hands it out as a plain cell", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", "a@example.com", '{"plan":"pro"}'));
      assert.strictEqual(yield* rawMetadata("u1"), '{"plan":"pro"}');
      const user = Option.getOrThrow(yield* store.get(userId("u1")));
      assert.strictEqual(
        Redacted.value(yield* Sealed.orDie(Option.getOrThrow(user.metadata).open)),
        '{"plan":"pro"}',
      );
    }).pipe(Effect.provide(Plain)),
  );

  it.effect("layerSealedPii stores ciphertext and reads the plaintext back", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", "a@example.com", '{"plan":"pro"}'));
      const raw = yield* rawMetadata("u1");
      assert.isString(raw);
      assert.notInclude(raw, "pro");
      const user = Option.getOrThrow(yield* store.get(userId("u1")));
      assert.strictEqual(
        Redacted.value(yield* Sealed.orDie(Option.getOrThrow(user.metadata).open)),
        '{"plan":"pro"}',
      );
      // An update re-seals under the row's own AAD.
      yield* store.updateProfile({
        id: userId("u1"),
        name: "n",
        image: { _tag: "Keep" },
        metadata: { _tag: "Set", value: '{"plan":"free"}' },
        at: at(1),
      });
      const updated = yield* rawMetadata("u1");
      assert.notInclude(updated, "free");
    }).pipe(Effect.provide(SealedStore)),
  );
});

describe("UserStoreSql statements", () => {
  // PPS-007 (moved from the repository suite): the identity swap that applies is one statement, with
  // no read-back after it; a stale one reads the current row once.
  it.effect("casIdentity is one UPDATE when it applies, and reads once only to tell Stale", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const faults = yield* FaultySql.FaultControl;
      yield* store.insertOrHolder(newUser("u1", "a@example.com"));
      const before = UserStore.identityOf(Option.getOrThrow(yield* store.get(userId("u1"))));
      yield* faults.reset;
      const applied = yield* store.casIdentity({
        id: userId("u1"),
        expected: before,
        next: { ...before, emailVerified: true },
        at: at(1),
      });
      assert.strictEqual(applied._tag, "Updated");
      assert.strictEqual(yield* faults.attempts(/^\s*update users/i), 1);
      assert.strictEqual(yield* faults.attempts(/^\s*select/i), 0);
      const stale = yield* store.casIdentity({
        id: userId("u1"),
        expected: before,
        next: { ...before, emailVerified: true },
        at: at(2),
      });
      assert.strictEqual(stale._tag, "Stale");
      assert.strictEqual(yield* faults.attempts(/^\s*select/i), 1);
    }).pipe(Effect.provide(FaultyStore)),
  );
});

describe("UserStoreSql casIdentity in a transaction", () => {
  // The swap runs in its own savepoint, so a unique violation on the new email is `Taken` and the
  // caller's transaction stays usable (on Postgres a bare unique violation would abort it).
  it.effect("a collision is Taken and the enclosing transaction still commits its other work", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const transaction = yield* SqlTransaction.SqlTransaction;
      yield* store.insertOrHolder(newUser("u1", "a@example.com"));
      yield* store.insertOrHolder(newUser("u2", "b@example.com"));
      const before = UserStore.identityOf(Option.getOrThrow(yield* store.get(userId("u1"))));
      yield* transaction.withTransaction(
        Effect.gen(function* () {
          const outcome = yield* store.casIdentity({
            id: userId("u1"),
            expected: before,
            next: { ...before, email: Option.some("b@example.com") },
            at: at(1),
          });
          assert.strictEqual(outcome._tag, "Taken");
          yield* store.insertOrHolder(newUser("u3", "c@example.com"));
        }),
      );
      assert.isTrue(Option.isSome(yield* store.get(userId("u3"))));
    }).pipe(
      Effect.provide(Layer.mergeAll(Plain, SqlTransaction.layerSql.pipe(Layer.provide(SqlLive)))),
    ),
  );
});

describe("UserStoreSql failure mapping (MA-004)", () => {
  const identity: UserStore.IdentityColumns = {
    email: Option.some("a@example.com"),
    emailVerified: false,
    phone: Option.none(),
    phoneVerified: false,
  };

  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({
        count: Number.POSITIVE_INFINITY,
        reason: new UnknownError({ cause: new Error("database is down") }),
      });
      const id = userId("u1");
      const failures = {
        insertOrHolder: yield* store
          .insertOrHolder(newUser("u1", "a@example.com"))
          .pipe(Effect.flip),
        get: yield* store.get(id).pipe(Effect.flip),
        getByEmail: yield* store.getByEmail("a@example.com").pipe(Effect.flip),
        getByPhone: yield* store
          .getByPhone(Schema.decodeUnknownSync(Models.E164)("+14155550100"))
          .pipe(Effect.flip),
        updateProfile: yield* store
          .updateProfile({
            id,
            name: "n",
            image: { _tag: "Keep" },
            metadata: { _tag: "Keep" },
            at: at(1),
          })
          .pipe(Effect.flip),
        casIdentity: yield* store
          .casIdentity({ id, expected: identity, next: identity, at: at(1) })
          .pipe(Effect.flip),
        setStatus: yield* store
          .setStatus({
            id,
            status: "active",
            reason: Option.none(),
            until: Option.none(),
            at: at(1),
          })
          .pipe(Effect.flip),
        delete: yield* store.delete(id).pipe(Effect.flip),
        listPage: yield* store.listPage({ after: Option.none(), limit: 5 }).pipe(Effect.flip),
        readFields: yield* store.readFields(id, []).pipe(Effect.flip),
        writeFields: yield* store
          .writeFields({ id, values: {}, returning: [], at: at(1) })
          .pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `UserStore.${primitive}`);
      }
    }).pipe(Effect.provide(FaultyStore)),
  );
});
