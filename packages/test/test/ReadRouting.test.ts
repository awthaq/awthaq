// RRC-001 / RRC-008 (wayfinder ticket 28): opt-in read-replica routing and the
// causal handoffs it must never break (ADR-EA-014: revocation and rotation are
// authoritative on the very next read). The replica is a real second database
// that only changes when the test calls `catchUp` (`LaggingReplica`).
import * as TestEncryption from "../src/TestEncryption.ts";
import { AuditLog, AuthEvents, Persistence, Sessions, Users } from "@awthaq/core";
import { AuditLogStore, Ids, SessionStore } from "@awthaq/ports";
import { AuditLogStoreSql, CoreMigrations, ReadRouting, SessionStoreSql } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as LaggingReplica from "../src/LaggingReplica.ts";

/** Every SQL store over the ambient `SqlClient` (plan 02): provide it where the composition is built. */
const SqlStores = Persistence.sql().pipe(Layer.provide(TestEncryption.layer));

/** A fresh in-memory SQLite database with the core schema applied. */
const MigratedSqlite = Layer.unwrap(
  Effect.sync(() => {
    const client = SqliteClient.layer({ filename: ":memory:" });
    return Layer.provideMerge(
      Layer.effectDiscard(Migrator.make({})({ loader: CoreMigrations.coreMigrations })).pipe(
        Layer.provide(client),
      ),
      client,
    );
  }),
);

/** A migrated second database, wrapped as a lagging replica of the ambient primary. */
const newReplica = Effect.gen(function* () {
  // `fresh`: layers are memoized per build, and this must not be the primary's own client.
  const context = yield* Layer.build(Layer.fresh(MigratedSqlite));
  return yield* LaggingReplica.make({ replica: Context.get(context, SqlClient.SqlClient) });
});

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

const insertSession = (sessions: SessionStore.SessionStoreShape) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const later = DateTime.add(now, { hours: 1 });
    const outcome = yield* sessions.insert({
      session: {
        id: Ids.SessionId.make("sess-1"),
        userId,
        secretHash: "h",
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
    return outcome.inserted;
  });

const listCount = (
  sessions: SessionStore.SessionStoreShape,
  consistency: ReadRouting.Consistency = "authoritative",
) =>
  DateTime.now.pipe(
    Effect.flatMap((now) => sessions.listLive({ userId, now, limit: 100, consistency })),
    Effect.map((page) => page.items.length),
  );

describe("ReadRouting (RRC-001)", () => {
  it.effect("with no replica provided, every read goes to the primary", () =>
    Effect.gen(function* () {
      const router = yield* ReadRouting.makeRouter;
      assert.strictEqual(yield* router.target("eventual"), "primary");
      const sessions = yield* SessionStore.SessionStore;
      yield* insertSession(sessions);
      // An eventual read with no replica configured is simply the primary.
      assert.strictEqual(yield* listCount(sessions, "eventual"), 1);
      assert.strictEqual(yield* listCount(sessions), 1);
    }).pipe(Effect.provide(SessionStoreSql.layer.pipe(Layer.provideMerge(MigratedSqlite)))),
  );

  it.effect(
    "with a replica, only an eventual listing reads it; everything else reads the primary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lag = yield* newReplica;
          const context = yield* Layer.build(SessionStoreSql.layer.pipe(Layer.provide(lag.layer)));
          const sessions = Context.get(context, SessionStore.SessionStore);
          const session = yield* insertSession(sessions);

          // The replica has not caught up: it does not have the row yet.
          assert.strictEqual(yield* listCount(sessions, "eventual"), 0);
          // The default is authoritative, and point reads are primary-pinned.
          assert.strictEqual(yield* listCount(sessions), 1);
          assert.strictEqual(yield* listCount(sessions, "authoritative"), 1);
          assert.strictEqual(Option.getOrThrow(yield* sessions.get(session.id)).id, session.id);

          yield* lag.catchUp;
          assert.strictEqual(yield* listCount(sessions, "eventual"), 1);
        }).pipe(Effect.provide(MigratedSqlite)),
      ),
  );

  it.effect(
    "AuditLogStore.select is an eventual read when asked, and authoritative reads the primary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lag = yield* newReplica;
          const context = yield* Layer.build(AuditLogStoreSql.layer.pipe(Layer.provide(lag.layer)));
          const audit = Context.get(context, AuditLogStore.AuditLogStore);
          const now = yield* DateTime.now;
          yield* audit.append({
            id: "a1",
            eventTag: "auth.test",
            actorUserId: Option.none(),
            occurredAt: now,
            correlationId: Option.none(),
            tenantId: Option.none(),
            payloadJson: "{}",
          });
          const all = {
            eventTag: Option.none<string>(),
            actorUserId: Option.none<string>(),
            from: Option.none<DateTime.Utc>(),
            to: Option.none<DateTime.Utc>(),
          };
          assert.strictEqual((yield* audit.select(all, "eventual")).length, 0);
          assert.strictEqual((yield* audit.select(all, "authoritative")).length, 1);
          yield* lag.catchUp;
          assert.strictEqual((yield* audit.select(all, "eventual")).length, 1);
          const page = { after: Option.none<string>(), eventTag: Option.none<string>(), limit: 10 };
          assert.strictEqual((yield* audit.pageAfter(page, "eventual")).length, 1);
        }).pipe(Effect.provide(MigratedSqlite)),
      ),
  );

  it.effect(
    "a causal token ahead of the replica's position forces the primary until it catches up",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lag = yield* newReplica;
          const context = yield* Layer.build(SessionStoreSql.layer.pipe(Layer.provide(lag.layer)));
          const sessions = Context.get(context, SessionStore.SessionStore);
          const session = yield* insertSession(sessions);
          yield* lag.catchUp; // the replica now has the session

          // A write on the primary: `remove` captures the causal token itself (ADR-EA-024).
          const revokedInFiber = sessions.remove(session.id, Option.none()).pipe(
            Effect.andThen(
              Effect.all({
                eventual: listCount(sessions, "eventual"),
                authoritative: listCount(sessions),
              }),
            ),
            // The token is set on the fiber's own context; scope it to this case.
            Effect.provideService(ReadRouting.CurrentCausalToken, Option.none()),
            // `captureToken` reads the ambient replica config, so provide it at the
            // top of the request the way an application would.
            Effect.provide(lag.layer),
          );
          const during = yield* revokedInFiber;
          // The replica still has the row, but this fiber wrote after it: primary.
          assert.deepStrictEqual(during, { eventual: 0, authoritative: 0 });

          // A fiber with no token still sees the (stale) replica; catch-up ends the staleness.
          assert.strictEqual(yield* listCount(sessions, "eventual"), 1);
          yield* lag.catchUp;
          assert.strictEqual(yield* listCount(sessions, "eventual"), 0);
        }).pipe(Effect.provide(MigratedSqlite)),
      ),
  );

  it.effect("withCausalToken seeds a token from elsewhere (cross-request continuity)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lag = yield* newReplica;
        const context = yield* Layer.build(SessionStoreSql.layer.pipe(Layer.provide(lag.layer)));
        const sessions = Context.get(context, SessionStore.SessionStore);
        yield* insertSession(sessions);
        const ahead = Schema.decodeUnknownSync(ReadRouting.CausalToken)("5");
        // Replica position 0 < 5: primary, so the row is visible.
        const seeded = yield* listCount(sessions, "eventual").pipe(
          ReadRouting.withCausalToken(ahead),
        );
        assert.strictEqual(seeded, 1);
        assert.strictEqual(yield* listCount(sessions, "eventual"), 0);
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  it.effect(
    "failing to read the primary's position pins the fiber to the primary, never fails the write",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lag = yield* newReplica;
          const context = yield* Layer.build(SessionStoreSql.layer.pipe(Layer.provide(lag.layer)));
          const sessions = Context.get(context, SessionStore.SessionStore);
          // The write reaches the primary only; the replica stays empty.
          yield* insertSession(sessions);
          assert.strictEqual(yield* listCount(sessions, "eventual"), 0);

          const afterFailedCapture = yield* ReadRouting.captureToken(Effect.void).pipe(
            Effect.andThen(listCount(sessions, "eventual")),
            Effect.provideService(ReadRouting.CurrentCausalToken, Option.none()),
            // The position source is read when the write finishes; here it is down.
            Effect.provideService(ReadRouting.ReplicationPosition, {
              current: () => Effect.fail("position unavailable"),
              hasReplayed: () => Effect.succeed(true),
            }),
            Effect.provide(lag.layer),
          );
          // The write still succeeded, and the fiber is held to the primary (which has the row).
          assert.strictEqual(afterFailedCapture, 1);
        }).pipe(Effect.provide(MigratedSqlite)),
      ),
  );
});

// ---- RRC-008: the causal handoffs, through the real Sessions service -----------------

/** Sessions over a primary plus a lagging replica of it. */
const sessionsUnderLag = Effect.gen(function* () {
  const lag = yield* newReplica;
  const context = yield* Layer.build(
    Sessions.layer
      .pipe(Layer.provide(SqlStores))
      .pipe(
        Layer.provide(lag.layer),
        Layer.provide(Layer.mergeAll(NodeCrypto.layer, AuthEvents.layer)),
        Layer.provide(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
      ),
  );
  return { lag, sessions: Context.get(context, Sessions.Sessions) };
});

describe("causal handoffs under replica lag (RRC-008)", () => {
  it.effect("verify right after issue succeeds while the replica has never seen the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sessions } = yield* sessionsUnderLag;
        const { token } = yield* sessions.issue({ userId });
        const verified = yield* sessions.verify(token);
        assert.strictEqual(verified.session.userId, userId);
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  it.effect("verify after revoke fails even though the lagging replica still has the row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { lag, sessions } = yield* sessionsUnderLag;
        const { session, token } = yield* sessions.issue({ userId });
        yield* lag.catchUp; // the replica now holds the live session…
        yield* sessions.revoke(session.id, "userRevoked"); // …and is then left behind by the revoke
        const failure = yield* sessions.verify(token).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Sessions/NotFound");
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  // ADR-EA-024 section 3 (plan 02): the session store's writes capture the causal token, so a fiber that
  // just revoked and then asks for an *eventual* device list is read-your-writes: it is held to the
  // primary instead of seeing the revoked session on a lagging replica.
  it.effect("an eventual device list right after a revoke does not show the revoked session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { lag, sessions } = yield* sessionsUnderLag;
        const { session } = yield* sessions.issue({ userId });
        yield* lag.catchUp; // the replica holds the live session
        const listed = yield* sessions.revoke(session.id, "userRevoked").pipe(
          Effect.andThen(sessions.list(userId, undefined, { consistency: "eventual" })),
          // The token is set on the fiber's own context; scope it to this case, and give the fiber the
          // replica configuration the way an application provides it at the top of a request.
          Effect.provideService(ReadRouting.CurrentCausalToken, Option.none()),
          Effect.provide(lag.layer),
        );
        assert.strictEqual(listed.length, 0);
        // A fiber that wrote nothing still sees the stale replica until it catches up.
        const stale = yield* sessions.list(userId, undefined, { consistency: "eventual" });
        assert.strictEqual(stale.length, 1);
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );

  it.effect("a rotated session's new token verifies on the very next read under lag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { lag, sessions } = yield* sessionsUnderLag;
        const first = yield* sessions.issue({ userId });
        yield* lag.catchUp;
        const rotated = yield* sessions.issue({ userId, supersedes: first.session.id });
        const verified = yield* sessions.verify(rotated.token);
        assert.strictEqual(verified.session.id, rotated.session.id);
        // The superseded token is a tombstone on the primary, whatever the replica says.
        const old = yield* sessions.verify(first.token).pipe(Effect.flip);
        assert.strictEqual(old._tag, "Sessions/NotFound");
      }).pipe(Effect.provide(MigratedSqlite)),
    ),
  );
});
