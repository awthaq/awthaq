// Plan 02, phase 5: what only the SQL adapter of `UserStore` can show. What every adapter must do is
// `StoreContract.users` (`packages/test/test/StoreContract.*.test.ts`, also on Postgres under
// `pnpm test:pg`); this is the sealed metadata column, the holder that vanished between the two
// statements of an insert, a unique violation inside an enclosing transaction, and the failure mapping.
import { Encryption, KeyProvider, SqlTransaction, UserStore } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import * as UserStoreSql from "../src/UserStoreSql.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

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

const outage = () =>
  new SqlError({ reason: new UnknownError({ cause: new Error("database is down") }) });

const Plain = UserStoreSql.layer.pipe(
  Layer.provide(Repositories.UsersRepositoryLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

describe("UserStoreSql metadata at rest (CSG-006)", () => {
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
  const Sealed = UserStoreSql.layer.pipe(
    Layer.provide(Repositories.UsersRepositoryEncryptedLive.pipe(Layer.provide(EncryptionLive))),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  it.effect("the metadata is ciphertext in the table and plaintext through the port", () =>
    Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", "a@example.com", '{"plan":"pro"}'));
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly metadata: string | null;
      }>`SELECT metadata FROM users WHERE id = ${"u1"}`;
      assert.notInclude(rows[0]?.metadata ?? "", "pro");
      const stored = Option.getOrThrow(yield* store.get(userId("u1")));
      assert.deepStrictEqual(stored.metadata, Option.some('{"plan":"pro"}'));
      const updated = Option.getOrThrow(
        yield* store.updateProfile({
          id: userId("u1"),
          name: "u1",
          image: { _tag: "Keep" },
          metadata: { _tag: "Set", value: '{"plan":"free"}' },
          at: at(1),
        }),
      );
      assert.deepStrictEqual(updated.metadata, Option.some('{"plan":"free"}'));
    }).pipe(Effect.provide(Sealed)),
  );
});

describe("UserStoreSql insertOrHolder", () => {
  // A holder deleted between the two statements: the first insert finds a conflict, the holder read
  // finds nothing, and the insert is simply tried again (it is never a defect).
  it.effect("retries the insert when the holder it lost to has vanished", () => {
    const flaky = { insertCalls: 0 };
    const Vanishing = Layer.effect(
      Repositories.UsersRepository,
      Effect.gen(function* () {
        const real = yield* Repositories.UsersRepository;
        return {
          ...real,
          insertIfAbsent: (input: Parameters<typeof real.insertIfAbsent>[0]) =>
            Effect.suspend(() => {
              flaky.insertCalls += 1;
              return flaky.insertCalls === 1 ? Effect.succeedNone : real.insertIfAbsent(input);
            }),
          findByEmail: () => Effect.succeedNone,
        };
      }),
    ).pipe(Layer.provide(Repositories.UsersRepositoryLive));
    const VanishingStore = UserStoreSql.layer.pipe(
      Layer.provide(Vanishing),
      Layer.provideMerge(SqlLive),
      Layer.provideMerge(Migrated),
    );
    return Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const outcome = yield* store.insertOrHolder(newUser("u1", "a@example.com"));
      assert.strictEqual(outcome._tag, "Inserted");
      assert.strictEqual(flaky.insertCalls, 2);
    }).pipe(Effect.provide(VanishingStore));
  });

  it.effect("is StoreUnavailable, not a defect, when the key never frees up", () => {
    const Stuck = Layer.effect(
      Repositories.UsersRepository,
      Effect.gen(function* () {
        const real = yield* Repositories.UsersRepository;
        return {
          ...real,
          insertIfAbsent: () => Effect.succeedNone,
          findByEmail: () => Effect.succeedNone,
        };
      }),
    ).pipe(Layer.provide(Repositories.UsersRepositoryLive));
    const StuckStore = UserStoreSql.layer.pipe(
      Layer.provide(Stuck),
      Layer.provideMerge(SqlLive),
      Layer.provideMerge(Migrated),
    );
    return Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const failure = yield* store.insertOrHolder(newUser("u1", "a@example.com")).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(failure.operation, "UserStore.insertOrHolder");
    }).pipe(Effect.provide(StuckStore));
  });
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
  const DownRepository = Layer.effect(
    Repositories.UsersRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.UsersRepository;
      return {
        ...real,
        insertIfAbsent: () => Effect.fail(outage()),
        findById: () => Effect.fail(outage()),
        findByEmail: () => Effect.fail(outage()),
        findByPhone: () => Effect.fail(outage()),
        updateProfile: () => Effect.fail(outage()),
        casIdentity: () => Effect.fail(outage()),
        setStatus: () => Effect.fail(outage()),
        deleteReturning: () => Effect.fail(outage()),
        listPage: () => Effect.fail(outage()),
        readFields: () => Effect.fail(outage()),
        writeFieldsReturning: () => Effect.fail(outage()),
      };
    }),
  ).pipe(Layer.provide(Repositories.UsersRepositoryLive));

  const DownStore = UserStoreSql.layer.pipe(
    Layer.provide(DownRepository),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

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
    }).pipe(Effect.provide(DownStore)),
  );
});
