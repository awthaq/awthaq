// Plan 17 (ADR-EA-019 rev 1.3, BEH-EA-034/324): core's six sealed columns are declared `SealedColumn`s,
// under the canonical AAD, and a rotation sweep reaches them. The mechanism is proven once in
// `packages/sql/test/SealedColumn.test.ts`; these cases prove core used it. They run over
// `Persistence.sql({ encryptPii: true })` on SQLite, and on Postgres under `pnpm test:pg`.
import { AccountStore, Encryption, Ids, Sealed, SessionStore, UserStore } from "@awthaq/ports";
import { Persistence } from "@awthaq/core";
import { CoreMigrations, CoreSealedColumns, SealedColumn } from "@awthaq/sql";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { rotatingKeys } from "../../sql/test/support/RotatingKeys.ts";
import * as TestAuth from "../src/TestAuth.ts";
import * as TestSql from "../src/TestSql.ts";

const makeUserId = Schema.decodeUnknownSync(Ids.UserId);
const makeSessionId = Schema.decodeUnknownSync(Ids.SessionId);
const makeAccountId = Schema.decodeUnknownSync(Ids.AccountId);
const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);

/** The migrated database the stores run on (no `Encryption` yet: the caller supplies it). */
const storesOver = (suite: string, options: { readonly encryptPii: boolean }) => {
  const client = TestSql.layer(suite);
  const migrated = Layer.effectDiscard(
    Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
  ).pipe(Layer.provide(client));
  return Persistence.sql(options).pipe(Layer.provideMerge(migrated), Layer.provideMerge(client));
};

/**
 * `Persistence.sql(options)` over a migrated database and a key a test can rotate or retire. `decrypts`
 * counts every envelope the stores open, so a test can show a write path never decrypts.
 */
const environment = (
  suite: string,
  options: { readonly encryptPii: boolean } = { encryptPii: true },
) => {
  const keys = rotatingKeys();
  const decrypts = { count: 0 };
  const counted = Layer.effect(
    Encryption.Encryption,
    Effect.map(Encryption.Encryption, (encryption) =>
      Encryption.Encryption.of({
        encrypt: encryption.encrypt,
        decrypt: (envelope, aad) => {
          decrypts.count += 1;
          return encryption.decrypt(envelope, aad);
        },
      }),
    ),
  ).pipe(Layer.provide(keys.layer));
  return {
    keys,
    decrypts,
    layer: storesOver(suite, options).pipe(Layer.provideMerge(counted)),
  };
};

const newUser = (id: string, metadata: Option.Option<string>): UserStore.NewUser => ({
  id: makeUserId(id),
  email: Option.some(`${id}@example.com`),
  emailVerified: false,
  phone: Option.none(),
  phoneVerified: false,
  name: id,
  image: Option.none(),
  metadata,
  status: "active",
  statusReason: Option.none(),
  suspendedUntil: Option.none(),
  createdAt: at(0),
  updatedAt: at(0),
});

const newSession = (id: string, userId: string): SessionStore.NewSession => ({
  id: makeSessionId(id),
  userId: makeUserId(userId),
  secretHash: `hash-${id}`,
  at: at(0),
  absoluteExpiresAt: at(1000),
  idleExpiresAt: at(600),
  ipAddress: Option.some("203.0.113.9"),
  userAgent: Option.some("Agent/1.0"),
  actingAs: Option.none(),
  amr: [],
});

const newAccount = (id: string, userId: string, subject: string): AccountStore.NewAccount => ({
  id: makeAccountId(id),
  userId: makeUserId(userId),
  providerId: "github",
  subject,
  issuer: "",
  credentialHash: Option.none(),
  tokens: Option.some({
    accessToken: Redacted.make(`access-${subject}`),
    refreshToken: Option.some(Redacted.make(`refresh-${subject}`)),
    idToken: Option.some(Redacted.make(`id-${subject}`)),
    accessTokenExpiresAt: Option.none(),
    refreshTokenExpiresAt: Option.none(),
    scope: Option.none(),
    tokenType: Option.none(),
  }),
  createdAt: at(0),
  updatedAt: at(0),
});

/** What the runbook (`docs/plugin-authoring.md`) used to tell an operator to declare by hand. */
const handDeclared = {
  usersMetadata: { table: "users", column: "metadata", key: "id", adoptPlaintext: true },
  sessionsIpAddress: { table: "sessions", column: "ipAddress", key: "id", adoptPlaintext: true },
  sessionsUserAgent: { table: "sessions", column: "userAgent", key: "id", adoptPlaintext: true },
  accountsAccessToken: {
    table: "accounts",
    column: "accessToken",
    key: "id",
    adoptPlaintext: false,
  },
} satisfies Record<string, SealedColumn.Sweepable>;

/** A sealed optional cell, opened to its plaintext (fails `Unreadable`). */
const openText = (value: Option.Option<Sealed.Sealed<string>>) =>
  Effect.map(Sealed.openOption(value), Option.map(Redacted.value));

describe("core sealed columns: the bugs plan 17 fixes", () => {
  it.effect(
    "runbook: a sweep over users.metadata re-seals a stale row and counts no healthy row unreadable",
    () => {
      const { keys, layer } = environment("core_sealed_runbook");
      return Effect.gen(function* () {
        const users = yield* UserStore.UserStore;
        yield* users.insertOrHolder(newUser("u1", Option.some('{"a":1}')));
        keys.rotateTo("k2");
        const report = yield* SealedColumn.sweep(handDeclared.usersMetadata);
        assert.deepStrictEqual(report, { scanned: 1, resealed: 1, unreadable: 0 });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "runbook: a sweep never makes a plaintext metadata value unreadable to the store",
    () => {
      const { layer } = environment("core_sealed_plaintext");
      return Effect.gen(function* () {
        const users = yield* UserStore.UserStore;
        const sql = yield* SqlClient.SqlClient;
        yield* users.insertOrHolder(newUser("u2", Option.none()));
        yield* sql`UPDATE users SET metadata = ${'{"b":2}'} WHERE id = ${"u2"}`;
        yield* SealedColumn.sweep(handDeclared.usersMetadata);
        const read = Option.getOrThrow(yield* users.get(makeUserId("u2")));
        assert.deepStrictEqual(yield* openText(read.metadata), Option.some('{"b":2}'));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.fails(
    "a token moved to another account of the same user and provider does not open",
    () => {
      const { layer } = environment("core_sealed_moved_token");
      return Effect.gen(function* () {
        const users = yield* UserStore.UserStore;
        const accounts = yield* AccountStore.AccountStore;
        const sql = yield* SqlClient.SqlClient;
        yield* users.insertOrHolder(newUser("u3", Option.none()));
        yield* accounts.insertIfAbsent(newAccount("a1", "u3", "one"));
        yield* accounts.insertIfAbsent(newAccount("a2", "u3", "two"));
        const rows = yield* sql<{ readonly accessToken: string }>`
          SELECT "accessToken" FROM accounts WHERE id = ${"a1"}`;
        const first = rows[0]?.accessToken ?? "";
        yield* sql`UPDATE accounts SET "accessToken" = ${first} WHERE id = ${"a2"}`;
        const read = Option.getOrThrow(yield* accounts.readProviderTokens(makeAccountId("a2")));
        assert.strictEqual(read._tag, "Undecryptable");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.fails(
    "key retirement: after rotating and sweeping every deployed column, the retired key can be dropped and every core value still opens",
    () => {
      const { keys, layer } = environment("core_sealed_retirement");
      return Effect.gen(function* () {
        const users = yield* UserStore.UserStore;
        const sessions = yield* SessionStore.SessionStore;
        const accounts = yield* AccountStore.AccountStore;
        yield* users.insertOrHolder(newUser("u4", Option.some('{"k":1}')));
        yield* sessions.insert({
          session: newSession("s4", "u4"),
          supersedes: Option.none(),
          maxLive: Option.none(),
        });
        yield* accounts.insertIfAbsent(newAccount("a4", "u4", "four"));
        keys.rotateTo("k2");
        yield* SealedColumn.sweepAll(Object.values(handDeclared));
        keys.retire("k1");
        const user = Option.getOrThrow(yield* users.get(makeUserId("u4")));
        assert.deepStrictEqual(yield* openText(user.metadata), Option.some('{"k":1}'));
        const session = Option.getOrThrow(yield* sessions.get(makeSessionId("s4")));
        assert.deepStrictEqual(yield* openText(session.ipAddress), Option.some("203.0.113.9"));
        assert.deepStrictEqual(yield* openText(session.userAgent), Option.some("Agent/1.0"));
        const read = Option.getOrThrow(yield* accounts.readProviderTokens(makeAccountId("a4")));
        assert.strictEqual(read._tag, "Tokens");
      }).pipe(Effect.provide(layer));
    },
  );
});

// ---- the wiring suite, one call per core column (the same suite every plugin column runs) -------

const framework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body, 60_000),
  fail: (message) => {
    throw new Error(message);
  },
};

const rawColumn = (table: string, column: string) => (rowKey: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<Record<string, string | null>>`
      SELECT ${sql(column)} AS value FROM ${sql(table)} WHERE id = ${rowKey}`;
    return rows[0]?.["value"] ?? "";
  });

const plantColumn = (table: string, column: string) => (rowKey: string, stored: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = ${stored} WHERE id = ${rowKey}`;
  });

const sealedOrFail = <A>(value: Option.Option<Sealed.Sealed<A>>) =>
  Option.match(value, {
    onNone: () => Effect.die("expected the column to hold a value"),
    onSome: Effect.succeed,
  });

TestAuth.runSealedColumnTests(framework, {
  column: CoreSealedColumns.usersMetadata,
  sample: '{"plan":"pro"}',
  adapters: [
    {
      name: "Persistence.sql({ encryptPii: true })",
      layer: storesOver("core_sealed_wiring", { encryptPii: true }),
      raw: rawColumn("users", "metadata"),
      plant: plantColumn("users", "metadata"),
    },
  ],
  write: (rowKey, value) =>
    Effect.asVoid(
      Effect.flatMap(UserStore.UserStore, (users) =>
        users.insertOrHolder(newUser(rowKey, Option.some(value))),
      ),
    ),
  read: (rowKey) =>
    Effect.flatMap(UserStore.UserStore, (users) => users.get(makeUserId(rowKey))).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.die("no such user"), onSome: Effect.succeed }),
      ),
      Effect.flatMap((user) => sealedOrFail(user.metadata)),
    ),
});

const sessionColumn = (declared: SealedColumn.Column<string>, field: "ipAddress" | "userAgent") =>
  TestAuth.runSealedColumnTests(framework, {
    column: declared,
    sample: field === "ipAddress" ? "203.0.113.9" : "Agent/1.0",
    adapters: [
      {
        name: "Persistence.sql({ encryptPii: true })",
        layer: storesOver("core_sealed_wiring", { encryptPii: true }),
        raw: rawColumn("sessions", field),
        plant: plantColumn("sessions", field),
      },
    ],
    write: (rowKey, value) =>
      Effect.asVoid(
        Effect.flatMap(SessionStore.SessionStore, (sessions) =>
          sessions.insert({
            session: {
              ...newSession(rowKey, "u-wiring"),
              ipAddress: Option.some(field === "ipAddress" ? value : "203.0.113.1"),
              userAgent: Option.some(field === "userAgent" ? value : "Other/1.0"),
            },
            supersedes: Option.none(),
            maxLive: Option.none(),
          }),
        ),
      ),
    read: (rowKey) =>
      Effect.flatMap(SessionStore.SessionStore, (sessions) =>
        sessions.get(makeSessionId(rowKey)),
      ).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.die("no such session"), onSome: Effect.succeed }),
        ),
        Effect.flatMap((session) => sealedOrFail(session[field])),
      ),
  });

sessionColumn(CoreSealedColumns.sessionsIpAddress, "ipAddress");
sessionColumn(CoreSealedColumns.sessionsUserAgent, "userAgent");

// ---- what only core can show ---------------------------------------------------------------------

const seedUserAndSession = (
  users: UserStore.UserStoreShape,
  sessions: SessionStore.SessionStoreShape,
) =>
  Effect.gen(function* () {
    yield* users.insertOrHolder(newUser("u5", Option.some('{"k":5}')));
    yield* sessions.insert({
      session: newSession("s5", "u5"),
      supersedes: Option.none(),
      maxLive: Option.none(),
    });
  });

describe("core sealed columns: what only core can show", () => {
  it.effect(
    "encryptPii: false: the PII columns are stored as given and open through Sealed.plain",
    () => {
      const { layer } = environment("core_sealed_plain", { encryptPii: false });
      return Effect.gen(function* () {
        const users = yield* UserStore.UserStore;
        const sessions = yield* SessionStore.SessionStore;
        yield* seedUserAndSession(users, sessions);
        assert.strictEqual(yield* rawColumn("users", "metadata")("u5"), '{"k":5}');
        assert.strictEqual(yield* rawColumn("sessions", "ipAddress")("s5"), "203.0.113.9");
        assert.strictEqual(yield* rawColumn("sessions", "userAgent")("s5"), "Agent/1.0");
        const user = Option.getOrThrow(yield* users.get(makeUserId("u5")));
        assert.deepStrictEqual(yield* openText(user.metadata), Option.some('{"k":5}'));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a plaintext metadata row written before opting in opens and is sealed on read", () => {
    const { layer } = environment("core_sealed_adopt");
    return Effect.gen(function* () {
      const users = yield* UserStore.UserStore;
      yield* users.insertOrHolder(newUser("u6", Option.none()));
      yield* plantColumn("users", "metadata")("u6", '{"old":true}');
      const user = Option.getOrThrow(yield* users.get(makeUserId("u6")));
      assert.deepStrictEqual(yield* openText(user.metadata), Option.some('{"old":true}'));
      const stored = yield* rawColumn("users", "metadata")("u6");
      assert.isTrue(Encryption.looksLikeEnvelope(stored));
      assert.notInclude(stored, "old");
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes that never touch a sealed column leave its ciphertext alone", () => {
    const { layer } = environment("core_sealed_untouched");
    return Effect.gen(function* () {
      const users = yield* UserStore.UserStore;
      const sessions = yield* SessionStore.SessionStore;
      yield* seedUserAndSession(users, sessions);
      const before = {
        metadata: yield* rawColumn("users", "metadata")("u5"),
        ipAddress: yield* rawColumn("sessions", "ipAddress")("s5"),
        userAgent: yield* rawColumn("sessions", "userAgent")("s5"),
      };
      const user = Option.getOrThrow(yield* users.get(makeUserId("u5")));
      yield* users.casIdentity({
        id: makeUserId("u5"),
        expected: UserStore.identityOf(user),
        next: { ...UserStore.identityOf(user), emailVerified: true },
        at: at(2),
      });
      yield* users.setStatus({
        id: makeUserId("u5"),
        status: "suspended",
        reason: Option.some("test"),
        until: Option.none(),
        at: at(3),
      });
      yield* sessions.rotate({
        id: makeSessionId("s5"),
        expectedSecretHash: "hash-s5",
        secretHash: "hash-s5b",
        previous: Option.none(),
        lastActiveAt: at(4),
        idleExpiresAt: at(700),
      });
      yield* sessions.reauthenticate({
        id: makeSessionId("s5"),
        owner: makeUserId("u5"),
        at: at(5),
        addAmr: ["pwd"],
      });
      assert.deepStrictEqual(
        {
          metadata: yield* rawColumn("users", "metadata")("u5"),
          ipAddress: yield* rawColumn("sessions", "ipAddress")("s5"),
          userAgent: yield* rawColumn("sessions", "userAgent")("s5"),
        },
        before,
      );
      assert.strictEqual(yield* rawColumn("users", "email")("u5"), "u5@example.com");
    }).pipe(Effect.provide(layer));
  });

  it.effect("insertOrHolder and insert hand back what they wrote without decrypting it", () => {
    const { layer, decrypts } = environment("core_sealed_no_decrypt");
    return Effect.gen(function* () {
      const users = yield* UserStore.UserStore;
      const sessions = yield* SessionStore.SessionStore;
      const inserted = yield* users.insertOrHolder(newUser("u7", Option.some('{"w":1}')));
      assert.strictEqual(inserted._tag, "Inserted");
      if (inserted._tag === "Inserted") {
        assert.deepStrictEqual(yield* openText(inserted.user.metadata), Option.some('{"w":1}'));
      }
      const outcome = yield* sessions.insert({
        session: newSession("s7", "u7"),
        supersedes: Option.none(),
        maxLive: Option.none(),
      });
      assert.deepStrictEqual(
        yield* openText(outcome.inserted.ipAddress),
        Option.some("203.0.113.9"),
      );
      assert.strictEqual(decrypts.count, 0);
    }).pipe(Effect.provide(layer));
  });
});
