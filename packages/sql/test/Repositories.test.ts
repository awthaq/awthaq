// spec/behaviors/05-persistence-stratum.md, BEH-EA-033 through BEH-EA-036.
//
// Exercises `Models.ts`/`Repositories.ts` against a real, in-memory SQLite
// database (`node:sqlite` via `@effect/sql-sqlite-node`) — the same
// `SqlModel.makeRepository`/`SqlSchema` machinery a Postgres- or
// MySQL-backed deployment would use, so a passing test here is evidence
// against the real encode/decode/SQL round-trip, not just against an
// in-memory stand-in. The dialect-neutral cases live in `contract.ts` (shared
// with the file-backed and Postgres suites, ESR-009); the cases below are
// SQLite-specific or cheap enough to keep on the in-memory database only.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as Model from "effect/unstable/schema/Model";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import { contractCases, repositoriesLayer } from "./contract.ts";

const M = Models.makeModels("sqlite");

const RepositoriesLive = repositoriesLayer(SqliteClient.layer({ filename: ":memory:" }));

contractCases("Repositories", "sqlite", RepositoriesLive);

// ---- helpers shared by the SQLite-only cases -----------------------------------

const insertSession = (userId: Models.UserId, secretHash: string, createdAt: DateTime.Utc) =>
  Effect.gen(function* () {
    const sessions = yield* Repositories.SessionsRepository;
    return yield* sessions.insert(
      M.Session.insert.make({
        userId,
        secretHash,
        ipAddress: null,
        userAgent: null,
        absoluteExpiresAt: createdAt,
        idleExpiresAt: Model.Override(createdAt),
        createdAt: Model.Override(createdAt),
        authenticatedAt: Model.Override(createdAt),
        lastActiveAt: Model.Override(createdAt),
        actingAsType: null,
        actingAsId: null,
        familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
        supersededBy: null,
        supersededAt: null,
        reusedAt: null,
      }),
    );
  });

const insertUser = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Repositories.UsersRepository;
    return yield* users.insert(yield* M.User.insert.makeEffect({ email, name: email }));
  });

describe("Repositories (SQLite specifics)", () => {
  // ---- EOTS-008: named spans -----------------------------------------------------

  /** An in-memory tracer collecting every span this test's effect starts. */
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

  const isChildOf = (child: Tracer.NativeSpan, parent: Tracer.NativeSpan): boolean =>
    Option.isSome(child.parent) && child.parent.value.spanId === parent.spanId;

  it.effect("EOTS-008: hand-written repository methods emit named spans over sql.execute", () =>
    Effect.gen(function* () {
      const { spans, tracer } = collectSpans();
      const users = yield* Repositories.UsersRepository;
      const sessions = yield* Repositories.SessionsRepository;
      const verification = yield* Repositories.VerificationRepository;
      const now = yield* DateTime.now;
      const user = yield* insertUser("spans@example.com");
      const session = yield* insertSession(user.id, "hash-1", now);

      yield* Effect.provideService(
        Effect.gen(function* () {
          yield* users.findByEmail("spans@example.com");
          yield* sessions.touch({
            id: session.id,
            expectedSecretHash: "hash-1",
            secretHash: "hash-2",
            lastActiveAt: now,
            idleExpiresAt: now,
          });
          yield* verification.tryConsume({ identifier: "x:y", valueHash: "h", now });
        }),
        Tracer.Tracer,
        tracer,
      );

      for (const name of ["Users.findByEmail", "Sessions.touch", "VerificationTokens.tryConsume"]) {
        const span = spans.find((s) => s.name === name);
        assert.isDefined(span, `${name} span`);
        if (span === undefined) continue;
        assert.isTrue(
          spans.some((s) => s.name === "sql.execute" && isChildOf(s, span)),
          `${name} parents a sql.execute span`,
        );
      }
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("EOTS-008: no repository span attribute carries an email, identifier or hash", () =>
    Effect.gen(function* () {
      const { spans, tracer } = collectSpans();
      const users = yield* Repositories.UsersRepository;
      const accounts = yield* Repositories.AccountsRepository;
      const verification = yield* Repositories.VerificationRepository;
      const now = yield* DateTime.now;
      const user = yield* insertUser("secret-email@example.com");

      yield* Effect.provideService(
        Effect.gen(function* () {
          yield* users.findByEmail("secret-email@example.com");
          yield* accounts.findByProviderSubject("github", "subject-secret", "");
          yield* accounts.listByUser(user.id);
          yield* verification.findByIdentifier("verify-email:identifier-secret");
          yield* verification.tryConsume({
            identifier: "verify-email:identifier-secret",
            valueHash: "hash-secret",
            now,
          });
        }),
        Tracer.Tracer,
        tracer,
      );

      const repositorySpans = spans.filter((s) =>
        /^(Users|Accounts|Sessions|VerificationTokens|VerificationReservations|AuditLog)\./.test(
          s.name,
        ),
      );
      assert.isAbove(repositorySpans.length, 0);
      const attributes = JSON.stringify(repositorySpans.flatMap((s) => [...s.attributes]));
      for (const secret of [
        "secret-email@example.com",
        "subject-secret",
        "identifier-secret",
        "hash-secret",
      ]) {
        assert.notInclude(attributes, secret);
      }
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  // ---- PPS-007 -----------------------------------------------------------------------

  /** Number of statements `effect` runs, counted from `sql.execute` client spans. */
  const statementsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { spans, tracer } = collectSpans();
      yield* Effect.provideService(effect, Tracer.Tracer, tracer);
      return spans.filter((s) => s.name === "sql.execute").length;
    });

  it.effect("PPS-007: verifyEmail returns the updated row from a single statement", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const user = yield* insertUser("verify-once@example.com");
      let verified = user;
      const statements = yield* statementsOf(
        users.verifyEmail(user.id).pipe(
          Effect.tap((row) =>
            Effect.sync(() => {
              verified = row;
            }),
          ),
        ),
      );
      assert.strictEqual(statements, 1);
      assert.isTrue(verified.emailVerified);
      assert.isTrue(DateTime.isGreaterThanOrEqualTo(verified.updatedAt, user.updatedAt));
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("PPS-007: verifyEmail on an unknown id fails NoSuchElementError", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const failure = yield* users
        .verifyEmail(Schema.decodeUnknownSync(Models.UserId)("missing"))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "NoSuchElementError");
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  // ---- SEA-005: the TEXT-timestamp encoding invariant ----------------------------

  const ISO_FIXED_WIDTH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it.effect(
    "SEA-005: every persisted SQLite timestamp is fixed-width ISO-8601 UTC with milliseconds",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const users = yield* Repositories.UsersRepository;
        const sessions = yield* Repositories.SessionsRepository;
        const accounts = yield* Repositories.AccountsRepository;
        const verification = yield* Repositories.VerificationRepository;
        const reservations = yield* Repositories.VerificationReservationsRepository;
        const auditLog = yield* Repositories.AuditLogRepository;
        const now = yield* DateTime.now;

        // Every write path that encodes a timestamp.
        const user = yield* insertUser("sea005@example.com");
        yield* users.verifyEmail(user.id);
        const session = yield* insertSession(user.id, "h1", now);
        yield* sessions.touch({
          id: session.id,
          expectedSecretHash: "h1",
          secretHash: "h2",
          lastActiveAt: now,
          idleExpiresAt: now,
        });
        const next = yield* insertSession(user.id, "h3", now);
        yield* sessions.tombstone({ id: session.id, supersededBy: next.id, supersededAt: now });
        yield* sessions.markReused(session.id, now);
        yield* sessions.reauthenticate(next.id, now);
        yield* accounts.insert(
          yield* M.Account.insert.makeEffect({
            userId: user.id,
            providerId: "github",
            subject: "sea005",
            issuer: "",
            passwordHash: null,
            accessToken: null,
            refreshToken: null,
          }),
        );
        const account = yield* accounts.findByProviderSubject("github", "sea005", "");
        yield* accounts.updateProviderTokens(
          Option.getOrThrow(account).id,
          { providerId: "github", userId: user.id },
          {
            accessToken: "a",
            refreshToken: "r",
            idToken: null,
            accessTokenExpiresAt: now,
            refreshTokenExpiresAt: now,
            scope: null,
            tokenType: null,
          },
        );
        yield* verification.upsertLive({
          id: Schema.decodeUnknownSync(Models.VerificationTokenId)("t1"),
          identifier: "verify-email:sea005",
          userId: null,
          valueHash: "vh",
          expiresAt: DateTime.add(now, { minutes: 5 }),
          createdAt: now,
          payload: null,
        });
        yield* verification.tryConsume({
          identifier: "verify-email:sea005",
          valueHash: "vh",
          now,
        });
        yield* reservations.claim({
          identifier: "sea005",
          expiresAt: DateTime.add(now, { minutes: 1 }),
          now,
        });
        yield* auditLog.insert({
          id: "a1",
          eventTag: "test",
          actorUserId: null,
          occurredAt: now,
          correlationId: null,
          payload: {},
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
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "SEA-005: keyset order equals epoch order across second and millisecond rollovers",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* insertUser("sea005-order@example.com");
        const base = DateTime.makeUnsafe("2026-03-01T00:00:00.000Z");
        // Spans a ms tick, a .999 -> .000 rollover, a second rollover and a minute rollover.
        const offsets = [0, 1, 999, 1000, 1001, 59_999, 60_000, 3_600_000];
        const shuffled = [5, 2, 7, 0, 3, 6, 1, 4];
        for (const i of shuffled) {
          yield* insertSession(
            user.id,
            `h${i}`,
            DateTime.add(base, { milliseconds: offsets[i] ?? 0 }),
          );
        }
        const collected: Array<number> = [];
        let cursor: Repositories.Cursor | undefined = undefined;
        for (;;) {
          const page: Repositories.Page<Models.Session> = yield* sessions.listByUser(
            user.id,
            // Each fixture row expires at its own createdAt, so list from just before the first.
            DateTime.subtract(base, { seconds: 1 }),
            cursor,
            3,
          );
          for (const item of page.items) collected.push(DateTime.toEpochMillis(item.createdAt));
          if (Option.isNone(page.nextCursor)) break;
          cursor = page.nextCursor.value;
        }
        const expected = offsets.map((o) => DateTime.toEpochMillis(base) + o);
        assert.deepStrictEqual(collected, expected);
      }).pipe(Effect.provide(RepositoriesLive)),
  );
  // PPS-002: the page query must be served by the partial composite index,
  // with no temp B-tree sort. This is the exact statement `listByUser` runs.
  it.effect("PPS-002: the page query is served by sessions_user_created_live, with no sort", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE "userId" = ?
           AND "supersededAt" IS NULL
           AND "absoluteExpiresAt" > ?
           AND "idleExpiresAt" > ?
           AND ("createdAt", id) > (?, ?)
           ORDER BY "createdAt" ASC, id ASC LIMIT ?`,
        ["u", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01", "x", 10],
      );
      const detail = plan.map((row) => row.detail).join("\n");
      assert.include(detail, "sessions_user_created_live");
      assert.notInclude(detail, "USE TEMP B-TREE FOR ORDER BY");
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  // PPS-003: `findByIdentifier` is served by the partial unique live-identifier
  // index with no temp b-tree.
  it.effect("PPS-003: findByIdentifier's query plan uses the partial unique live-identifier index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM verification_tokens WHERE identifier = ? AND "consumedAt" IS NULL`,
        ["verify-email:user-1"],
      );
      const detail = plan.map((row) => row.detail).join(" | ");
      assert.include(detail, "verification_tokens_live_identifier");
      assert.notInclude(detail, "TEMP B-TREE");
    }).pipe(Effect.provide(RepositoriesLive)),
  );
});
