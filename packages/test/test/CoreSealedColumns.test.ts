// Plan 17 (ADR-EA-019 rev 1.3, BEH-EA-034/324): core's six sealed columns are declared `SealedColumn`s,
// under the canonical AAD, and a rotation sweep reaches them. The mechanism is proven once in
// `packages/sql/test/SealedColumn.test.ts`; these cases prove core used it. They run over
// `Persistence.sql({ encryptPii: true })` on SQLite, and on Postgres under `pnpm test:pg`.
import { Ids, SessionStore, UserStore, AccountStore } from "@awthaq/ports";
import { Persistence } from "@awthaq/core";
import { CoreMigrations, SealedColumn } from "@awthaq/sql";
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
import * as TestSql from "../src/TestSql.ts";

const makeUserId = Schema.decodeUnknownSync(Ids.UserId);
const makeSessionId = Schema.decodeUnknownSync(Ids.SessionId);
const makeAccountId = Schema.decodeUnknownSync(Ids.AccountId);
const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);

/** `Persistence.sql({ encryptPii: true })` over a migrated database and a key a test can rotate or retire. */
const environment = (suite: string) => {
  const keys = rotatingKeys();
  const client = TestSql.layer(suite);
  const migrated = Layer.effectDiscard(
    Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
  ).pipe(Layer.provide(client));
  const layer = Persistence.sql({ encryptPii: true }).pipe(
    Layer.provideMerge(keys.layer),
    Layer.provideMerge(migrated),
    Layer.provideMerge(client),
  );
  return { keys, layer };
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

describe("core sealed columns: the bugs plan 17 fixes", () => {
  it.effect.fails(
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

  it.effect.fails(
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
        assert.deepStrictEqual(read.metadata, Option.some('{"b":2}'));
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
        assert.deepStrictEqual(user.metadata, Option.some('{"k":1}'));
        const session = Option.getOrThrow(yield* sessions.get(makeSessionId("s4")));
        assert.deepStrictEqual(session.ipAddress, Option.some("203.0.113.9"));
        assert.deepStrictEqual(session.userAgent, Option.some("Agent/1.0"));
        const read = Option.getOrThrow(yield* accounts.readProviderTokens(makeAccountId("a4")));
        assert.strictEqual(read._tag, "Tokens");
      }).pipe(Effect.provide(layer));
    },
  );
});
