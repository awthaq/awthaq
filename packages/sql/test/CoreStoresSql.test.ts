// Plan 16: the bundle, and the SQLite-specific properties that cut across every store adapter. Each
// store's own behaviour is `StoreContract` (Ref, SQLite, WAL, libSQL and Postgres); what only a real
// SQLite database over the whole bundle can show lives here: the bundle builds and provides all six
// stores, statement spans parent `sql.execute` and carry no personal data (EOTS-008), and every
// persisted timestamp is one fixed-width encoding (SEA-005).
import {
  AccountStore,
  AuditLogStore,
  Encryption,
  KeyProvider,
  SessionStore,
  SqlTransaction,
  UserStore,
  VerificationStore,
} from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as CoreStoresSql from "../src/CoreStoresSql.ts";
import * as Models from "../src/Models.ts";
import * as SealedColumn from "../src/SealedColumn.ts";

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

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

/** The bundle over one migrated in-memory database. */
const Bundle = (options?: CoreStoresSql.Options) =>
  CoreStoresSql.layer(options).pipe(
    Layer.provide(EncryptionLive),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

const userId = Schema.decodeUnknownSync(Models.UserId);
const accountId = Schema.decodeUnknownSync(Models.AccountId);
const sessionId = Schema.decodeUnknownSync(Models.SessionId);
const tokenId = Schema.decodeUnknownSync(Models.VerificationTokenId);

/** One user stored through the port. */
const addUser = (id: string, email: string, createdAt: DateTime.Utc) =>
  Effect.flatMap(UserStore.UserStore, (users) =>
    users.insertOrHolder({
      id: userId(id),
      email: Option.some(email),
      emailVerified: false,
      phone: Option.none(),
      phoneVerified: false,
      name: id,
      image: Option.none(),
      metadata: Option.none(),
      status: "active",
      statusReason: Option.none(),
      suspendedUntil: Option.none(),
      createdAt,
      updatedAt: createdAt,
    }),
  );

const newSession = (
  id: string,
  user: string,
  secretHash: string,
  at: DateTime.Utc,
  lifetimeMinutes: number,
): SessionStore.NewSession => ({
  id: sessionId(id),
  userId: userId(user),
  secretHash,
  at,
  absoluteExpiresAt: DateTime.add(at, { minutes: lifetimeMinutes }),
  idleExpiresAt: DateTime.add(at, { minutes: lifetimeMinutes }),
  ipAddress: Option.none(),
  userAgent: Option.none(),
  actingAs: Option.none(),
  amr: [],
});

/** An in-memory tracer collecting every span the effect it is provided to starts. */
const collectSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

describe("CoreStoresSql (the bundle)", () => {
  it.effect(
    "builds over a SqlClient and an Encryption and provides all six stores and the transaction",
    () =>
      Effect.gen(function* () {
        yield* UserStore.UserStore;
        yield* AccountStore.AccountStore;
        yield* SessionStore.SessionStore;
        yield* VerificationStore.VerificationStore;
        yield* AuditLogStore.AuditLogStore;
        yield* SqlTransaction.SqlTransaction;
        const deployed = yield* SealedColumn.Deployed;
        // Without `encryptPii` only the provider tokens are sealed.
        assert.isAbove(deployed.columns.length, 0);
      }).pipe(Effect.provide(Bundle())),
  );

  it.effect("encryptPii adds the users and sessions columns to the deployed list", () =>
    Effect.gen(function* () {
      const plain = yield* Effect.provide(SealedColumn.Deployed, Bundle());
      const sealed = yield* Effect.provide(SealedColumn.Deployed, Bundle({ encryptPii: true }));
      assert.isAbove(sealed.columns.length, plain.columns.length);
    }),
  );
});

describe("CoreStoresSql spans (EOTS-008)", () => {
  /**
   * A statement's client span. effect 4.1 names it after the database (OpenTelemetry database
   * span conventions: `db.namespace`, else `db.system.name`, else `sql.execute`), so it is
   * recognised by the `db.query.text` attribute every statement span carries, not by name.
   */
  const isStatement = (span: Tracer.NativeSpan): boolean => span.attributes.has("db.query.text");

  const isChildOf = (child: Tracer.NativeSpan, parent: Tracer.NativeSpan): boolean =>
    Option.isSome(child.parent) && child.parent.value.spanId === parent.spanId;

  it.effect("statement spans are named after the statement and parent the statement span", () =>
    Effect.gen(function* () {
      const { spans, tracer } = collectSpans();
      const users = yield* UserStore.UserStore;
      const sessions = yield* SessionStore.SessionStore;
      const verification = yield* VerificationStore.VerificationStore;
      const now = yield* DateTime.now;
      yield* addUser("spans", "spans@example.com", now);
      yield* sessions.insert({
        session: newSession("s1", "spans", "hash-1", now, 60),
        supersedes: Option.none(),
        maxLive: Option.none(),
      });
      yield* Effect.provideService(
        Effect.gen(function* () {
          yield* users.getByEmail("spans@example.com");
          yield* sessions.rotate({
            id: sessionId("s1"),
            expectedSecretHash: "hash-1",
            secretHash: "hash-2",
            previous: Option.none(),
            lastActiveAt: now,
            idleExpiresAt: DateTime.add(now, { minutes: 30 }),
          });
          yield* verification.present({ identifier: "x:y", valueHash: "h", now, hold: false });
        }),
        Tracer.Tracer,
        tracer,
      );
      for (const name of ["Users.findByEmail", "Sessions.touch", "VerificationTokens.tryConsume"]) {
        const span = spans.find((s) => s.name === name);
        assert.isDefined(span, `${name} span`);
        if (span === undefined) continue;
        assert.isTrue(
          spans.some((s) => isStatement(s) && isChildOf(s, span)),
          `${name} parents a statement span`,
        );
      }
    }).pipe(Effect.provide(Bundle())),
  );

  it.effect("no span attribute carries an email, identifier or hash", () =>
    Effect.gen(function* () {
      const { spans, tracer } = collectSpans();
      const users = yield* UserStore.UserStore;
      const accounts = yield* AccountStore.AccountStore;
      const verification = yield* VerificationStore.VerificationStore;
      const now = yield* DateTime.now;
      yield* addUser("secret", "secret-email@example.com", now);
      yield* Effect.provideService(
        Effect.gen(function* () {
          yield* users.getByEmail("secret-email@example.com");
          yield* accounts.getByKey("github", "subject-secret", "");
          yield* accounts.listByUser(userId("secret"));
          yield* verification.present({
            identifier: "verify-email:identifier-secret",
            valueHash: "hash-secret",
            now,
            hold: false,
          });
        }),
        Tracer.Tracer,
        tracer,
      );
      const storeSpans = spans.filter((s) =>
        /^(Users|Accounts|Sessions|VerificationTokens|VerificationReservations|AuditLog)\./.test(
          s.name,
        ),
      );
      assert.isAbove(storeSpans.length, 0);
      const attributes = JSON.stringify(storeSpans.flatMap((s) => [...s.attributes]));
      for (const secret of [
        "secret-email@example.com",
        "subject-secret",
        "identifier-secret",
        "hash-secret",
      ]) {
        assert.notInclude(attributes, secret);
      }
    }).pipe(Effect.provide(Bundle())),
  );
});

describe("CoreStoresSql timestamps (SEA-005)", () => {
  const ISO_FIXED_WIDTH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it.effect("every persisted SQLite timestamp is fixed-width ISO-8601 UTC with milliseconds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const users = yield* UserStore.UserStore;
      const sessions = yield* SessionStore.SessionStore;
      const accounts = yield* AccountStore.AccountStore;
      const verification = yield* VerificationStore.VerificationStore;
      const audit = yield* AuditLogStore.AuditLogStore;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { minutes: 5 });

      // Every write path that encodes a timestamp.
      const created = yield* addUser("u1", "sea005@example.com", now);
      const user = created._tag === "Inserted" ? created.user : yield* Effect.die("held");
      yield* users.casIdentity({
        id: user.id,
        expected: UserStore.identityOf(user),
        next: { ...UserStore.identityOf(user), emailVerified: true },
        at: now,
      });
      yield* sessions.insert({
        session: newSession("s1", "u1", "h1", now, 120),
        supersedes: Option.none(),
        maxLive: Option.none(),
      });
      yield* sessions.insert({
        session: newSession("s2", "u1", "h3", now, 120),
        supersedes: Option.some(sessionId("s1")),
        maxLive: Option.none(),
      });
      yield* sessions.rotate({
        id: sessionId("s2"),
        expectedSecretHash: "h3",
        secretHash: "h4",
        previous: Option.some({ hash: "h3", expiresAt: later }),
        lastActiveAt: later,
        idleExpiresAt: DateTime.add(later, { minutes: 30 }),
      });
      yield* sessions.flagReuse(sessionId("s1"), now);
      yield* sessions.reauthenticate({
        id: sessionId("s2"),
        owner: userId("u1"),
        at: later,
        addAmr: ["otp"],
      });
      yield* accounts.insertIfAbsent({
        id: accountId("a1"),
        userId: userId("u1"),
        providerId: "github",
        subject: "sea005",
        issuer: "",
        credentialHash: Option.none(),
        tokens: Option.none(),
        createdAt: now,
        updatedAt: now,
      });
      yield* accounts.writeProviderTokens(
        accountId("a1"),
        {
          accessToken: Redacted.make("a"),
          refreshToken: Option.some(Redacted.make("r")),
          idToken: Option.none(),
          accessTokenExpiresAt: Option.some(now),
          refreshTokenExpiresAt: Option.some(now),
          scope: Option.none(),
          tokenType: Option.none(),
        },
        now,
      );
      yield* verification.upsertLive({
        id: tokenId("t1"),
        identifier: "verify-email:sea005",
        userId: Option.none(),
        valueHash: "vh",
        expiresAt: later,
        createdAt: now,
        payloadJson: Option.none(),
        maxAttempts: Option.none(),
      });
      yield* verification.present({
        identifier: "verify-email:sea005",
        valueHash: "vh",
        now,
        hold: false,
      });
      yield* verification.reserve({
        identifier: "sea005",
        expiresAt: DateTime.add(now, { minutes: 1 }),
        now,
      });
      yield* audit.append({
        id: "a1",
        eventTag: "test",
        actorUserId: Option.none(),
        occurredAt: now,
        correlationId: Option.none(),
        tenantId: Option.none(),
        payloadJson: "{}",
      });

      const columns: ReadonlyArray<readonly [table: string, column: string]> = [
        ["users", "createdAt"],
        ["users", "updatedAt"],
        ["sessions", "createdAt"],
        ["sessions", "absoluteExpiresAt"],
        ["sessions", "idleExpiresAt"],
        ["sessions", "lastActiveAt"],
        ["sessions", "authenticatedAt"],
        ["sessions", "supersededAt"],
        ["sessions", "reusedAt"],
        ["accounts", "createdAt"],
        ["accounts", "updatedAt"],
        ["accounts", "accessTokenExpiresAt"],
        ["accounts", "refreshTokenExpiresAt"],
        ["verification_tokens", "createdAt"],
        ["verification_tokens", "expiresAt"],
        ["verification_tokens", "consumedAt"],
        ["verification_reservations", "expiresAt"],
        ["auth_audit_log", "occurredAt"],
      ];
      for (const [table, column] of columns) {
        const rows = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT "${column}" AS value FROM ${table} WHERE "${column}" IS NOT NULL`,
        );
        const seen = rows.filter((r) => r["value"] !== null);
        assert.isAbove(seen.length, 0, `${table}.${column} was exercised`);
        for (const row of seen) {
          const value = row["value"];
          assert.isString(value, `${table}.${column} is TEXT`);
          assert.match(String(value), ISO_FIXED_WIDTH, `${table}.${column} encoding`);
        }
      }
    }).pipe(Effect.provide(Bundle())),
  );

  it.effect("keyset order equals epoch order across second and millisecond rollovers", () =>
    Effect.gen(function* () {
      const users = yield* UserStore.UserStore;
      const base = DateTime.makeUnsafe("2026-03-01T00:00:00.000Z");
      // Spans a ms tick, a .999 -> .000 rollover, a second rollover and a minute rollover.
      const offsets = [0, 1, 999, 1000, 1001, 59_999, 60_000, 3_600_000];
      const shuffled = [5, 2, 7, 0, 3, 6, 1, 4];
      for (const i of shuffled) {
        yield* addUser(
          `k${i}`,
          `k${i}@example.com`,
          DateTime.add(base, { milliseconds: offsets[i] ?? 0 }),
        );
      }
      const collected: Array<number> = [];
      let after = Option.none<UserStore.UserCursor>();
      for (;;) {
        const page = yield* users.listPage({ after, limit: 3 });
        for (const item of page.items) collected.push(DateTime.toEpochMillis(item.createdAt));
        if (Option.isNone(page.next)) break;
        after = page.next;
      }
      assert.deepStrictEqual(
        collected,
        offsets.map((o) => DateTime.toEpochMillis(base) + o),
      );
    }).pipe(Effect.provide(Bundle())),
  );
});
