// spec/behaviors/07-sessions.md, BEH-EA-049 through BEH-EA-056.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — since `TestClock` (auto-provided by
// `it.effect`) is the ambient `Clock` both `DateTime.now` and the SQL
// model's own constructor defaults read from, so `TestClock.adjust`
// controls simulated time identically for either backend.
import { Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Sessions.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const shortLivedConfig = Layer.succeed(Sessions.SessionConfig, {
  absolute: Duration.millis(1000),
  idle: Duration.millis(500),
  touchEvery: Duration.millis(100),
});

const ShortLivedMemoryLayer = Sessions.layerMemory.pipe(
  Layer.provide(Layer.mergeAll(NodeCrypto.layer, shortLivedConfig)),
);

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        secretHash TEXT NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        absoluteExpiresAt TEXT NOT NULL,
        idleExpiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastActiveAt TEXT NOT NULL,
        actingAsType TEXT,
        actingAsId TEXT
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = Sessions.layerSql.pipe(
  Layer.provide(Repositories.SessionsRepositoryLive),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const ShortLivedSqlLayer = Sessions.layerSql.pipe(
  Layer.provide(Repositories.SessionsRepositoryLive),
  Layer.provide(Layer.mergeAll(NodeCrypto.layer, shortLivedConfig)),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

const suite = (
  name: string,
  layer: Layer.Layer<Sessions.Sessions, unknown, never>,
  shortLivedLayer: Layer.Layer<Sessions.Sessions, unknown, never>,
): void => {
  describe(name, () => {
    it.effect(
      "BEH-EA-049/050: issues an opaque id.secret token, never storing the secret itself",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session, token } = yield* sessions.issue({ userId });
          const raw = Redacted.value(token);
          assert.include(raw, ".");
          assert.strictEqual(raw.split(".")[0], session.id);

          const { session: view } = yield* sessions.verify(token);
          assert.strictEqual(view.id, session.id);
          assert.strictEqual(view.userId, userId);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-050/056: a tampered secret is rejected", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        const bogus = Redacted.make(`${session.id}.not-the-real-secret`);
        const failure = yield* sessions.verify(bogus).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SessionNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-051/INV-EA-008: idle refresh never pushes past the absolute expiry", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        // Cross two touchEvery windows, staying under idle (500ms) each
        // time, but past the 1000ms absolute ceiling in total. Ticket 01:
        // each touched verify rotates the secret, so the freshly-rotated
        // token (when present) must be used for the next call — the old
        // one no longer verifies.
        yield* TestClock.adjust(Duration.millis(400));
        const first = yield* sessions.verify(token);
        const afterFirst = Option.getOrElse(first.rotated, () => token);
        yield* TestClock.adjust(Duration.millis(400));
        const second = yield* sessions.verify(afterFirst);
        const afterSecond = Option.getOrElse(second.rotated, () => afterFirst);
        yield* TestClock.adjust(Duration.millis(400));
        const failure = yield* sessions.verify(afterSecond).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SessionExpired");
      }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect(
      "BEH-EA-051: idle expiry fires before the absolute ceiling when idle is exhausted",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.millis(600));
          const failure = yield* sessions.verify(token).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "SessionExpired");
        }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect("BEH-EA-052: idle refresh is throttled to at most one write per touchEvery", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({ userId });
        // Well under touchEvery (100ms) — no refresh yet.
        yield* TestClock.adjust(Duration.millis(10));
        const notTouched = yield* sessions.verify(token);
        assert.strictEqual(
          DateTime.toEpochMillis(notTouched.session.lastActiveAt),
          DateTime.toEpochMillis(session.createdAt),
        );
        // Past touchEvery — this verify earns a refresh.
        yield* TestClock.adjust(Duration.millis(200));
        const touched = yield* sessions.verify(token);
        assert.isTrue(
          DateTime.toEpochMillis(touched.session.lastActiveAt) >
            DateTime.toEpochMillis(session.createdAt),
        );
      }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect(
      "upstream-hardening ticket 01: the same throttled touch rotates the secret, invalidating the old token immediately",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { token } = yield* sessions.issue({ userId });
          // Under touchEvery — no rotation yet.
          yield* TestClock.adjust(Duration.millis(10));
          const notTouched = yield* sessions.verify(token);
          assert.deepStrictEqual(notTouched.rotated, Option.none());

          // Past touchEvery — this verify both refreshes and rotates.
          yield* TestClock.adjust(Duration.millis(200));
          const touched = yield* sessions.verify(token);
          assert.isTrue(Option.isSome(touched.rotated));

          // The old token no longer verifies — no grace window.
          const oldFails = yield* sessions.verify(token).pipe(Effect.flip);
          assert.strictEqual(oldFails._tag, "SessionNotFound");

          // The freshly-rotated token verifies and resolves the same session.
          const rotatedToken = Option.getOrThrow(touched.rotated);
          const { session: newView } = yield* sessions.verify(rotatedToken);
          assert.strictEqual(newView.id, touched.session.id);
        }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect("BEH-EA-053: issuing with `supersedes` deletes the prior row", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const first = yield* sessions.issue({ userId });
        const second = yield* sessions.issue({ userId, supersedes: first.session.id });
        const oldFails = yield* sessions.verify(first.token).pipe(Effect.flip);
        assert.strictEqual(oldFails._tag, "SessionNotFound");
        const newWorks = yield* sessions.verify(second.token);
        assert.strictEqual(newWorks.session.id, second.session.id);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-054: list/revoke/revokeOthers", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const a = yield* sessions.issue({ userId, request: { userAgent: "device-a" } });
        const b = yield* sessions.issue({ userId, request: { userAgent: "device-b" } });

        const listed = yield* sessions.list(userId, a.session.id);
        assert.strictEqual(listed.length, 2);
        const current = listed.find((row) => row.current);
        assert.strictEqual(current?.id, a.session.id);

        yield* sessions.revokeOthers(userId, a.session.id);
        const bFails = yield* sessions.verify(b.token).pipe(Effect.flip);
        assert.strictEqual(bFails._tag, "SessionNotFound");
        const aStillWorks = yield* sessions.verify(a.token);
        assert.strictEqual(aStillWorks.session.id, a.session.id);

        yield* sessions.revoke(a.session.id);
        const aFails = yield* sessions.verify(a.token).pipe(Effect.flip);
        assert.strictEqual(aFails._tag, "SessionNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "upstream-hardening ticket 02: revokeAll kills every session, including the caller's own",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const a = yield* sessions.issue({ userId, request: { userAgent: "device-a" } });
          const b = yield* sessions.issue({ userId, request: { userAgent: "device-b" } });

          yield* sessions.revokeAll(userId);

          const aFails = yield* sessions.verify(a.token).pipe(Effect.flip);
          assert.strictEqual(aFails._tag, "SessionNotFound");
          const bFails = yield* sessions.verify(b.token).pipe(Effect.flip);
          assert.strictEqual(bFails._tag, "SessionNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-209: actingAs round-trips through issue/verify", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({
          userId,
          actingAs: { type: "user", id: "admin-1" },
        });
        assert.deepStrictEqual(session.actingAs, Option.some({ type: "user", id: "admin-1" }));
        const verified = yield* sessions.verify(token);
        assert.deepStrictEqual(
          verified.session.actingAs,
          Option.some({ type: "user", id: "admin-1" }),
        );
        // Ticket 01: an actingAs session never touches the touch/rotation
        // path at all — its hard expiry is the whole security model.
        assert.deepStrictEqual(verified.rotated, Option.none());
      }).pipe(Effect.provide(layer)),
    );

    it.effect("an ordinary session issued with no actingAs carries none", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.issue({ userId });
        assert.deepStrictEqual(session.actingAs, Option.none());
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BEH-EA-210: a session issued with actingAs gets idleExpiresAt = absoluteExpiresAt",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session } = yield* sessions.issue({
            userId,
            actingAs: { type: "user", id: "admin-1" },
          });
          assert.strictEqual(
            DateTime.toEpochMillis(session.idleExpiresAt),
            DateTime.toEpochMillis(session.absoluteExpiresAt),
          );
        }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect("BEH-EA-210: verify never advances idleExpiresAt for an actingAs session", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({
          userId,
          actingAs: { type: "user", id: "admin-1" },
        });
        // Cross several touchEvery windows (100ms) — an ordinary session
        // would have its idleExpiresAt pushed forward each time.
        yield* TestClock.adjust(Duration.millis(200));
        const verified = yield* sessions.verify(token);
        assert.strictEqual(
          DateTime.toEpochMillis(verified.session.idleExpiresAt),
          DateTime.toEpochMillis(session.idleExpiresAt),
        );
        assert.strictEqual(
          DateTime.toEpochMillis(verified.session.lastActiveAt),
          DateTime.toEpochMillis(session.lastActiveAt),
        );
      }).pipe(Effect.provide(shortLivedLayer)),
    );

    it.effect(
      "BEH-EA-212: absoluteDuration overrides SessionConfig.absolute for this one call",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const now = yield* DateTime.now;
          const { session } = yield* sessions.issue({
            userId,
            absoluteDuration: Duration.millis(50),
          });
          assert.strictEqual(
            DateTime.toEpochMillis(session.absoluteExpiresAt),
            DateTime.toEpochMillis(now) + 50,
          );
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "an ordinary session's own idle-refresh is unaffected by the actingAs skip logic",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { session, token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.millis(200));
          const verified = yield* sessions.verify(token);
          assert.isTrue(
            DateTime.toEpochMillis(verified.session.lastActiveAt) >
              DateTime.toEpochMillis(session.lastActiveAt),
          );
        }).pipe(Effect.provide(shortLivedLayer)),
    );
  });
};

suite("Sessions (layerMemory)", MemoryLayer, ShortLivedMemoryLayer);
suite("Sessions (layerSql)", SqlLayer, ShortLivedSqlLayer);

describe("Sessions", () => {
  it("BEH-EA-055: the session cookie name and attributes are fixed", () => {
    assert.strictEqual(Sessions.SESSION_COOKIE_NAME, "__Host-session");
    assert.deepStrictEqual(Sessions.SESSION_COOKIE_ATTRIBUTES, {
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  });
});
