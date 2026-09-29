// Shipping-gap map (.scratch/shipping-gaps), ticket 15.
//
// The real, `@effect/sql-pg`-backed counterpart to `Repositories.test.ts`'s
// SQLite suite — same `Models`/`Repositories`, same `CoreMigrations.coreMigrations`
// migrator, a real Postgres database instead of an in-memory SQLite one. Skips
// (not fails) without `AWTHAQ_POSTGRES_URL` set — CI provisions a real
// Postgres service and sets it; a local run without one just proves nothing,
// rather than reporting a false failure for an environment gap.
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Model from "effect/unstable/schema/Model";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as ReadRouting from "../src/ReadRouting.ts";
import * as Repositories from "../src/Repositories.ts";
import * as TenantScope from "../src/TenantScope.ts";
import { contractCases, repositoriesLayer } from "./contract.ts";
import { regclassTypes } from "./support/TestSql.ts";

const M = Models.makeModels("pg");

const postgresUrl = process.env["AWTHAQ_POSTGRES_URL"];

const skip = postgresUrl === undefined;

const SqlLive = PgClient.layer({ url: Redacted.make(postgresUrl ?? "") });

// Forward-only migrator with no down migration (ticket 00's own finding) —
// each run starts from tables this suite drops and recreates itself. Only the
// tables `CoreMigrations` owns are dropped, never the whole schema: the
// rate-limiter suite shares this database and runs in parallel. Keep the list
// in step with `CoreMigrations.ts` (auth_audit_log was once missing from it).
const coreTables = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
  "effect_sql_migrations",
];

const RepositoriesLive = repositoriesLayer(
  SqlLive,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const table of coreTables) {
      yield* sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  }),
);

// ESR-009: the dialect-neutral contract cases, on a real server.
contractCases("Repositories contract (real Postgres)", "pg", RepositoriesLive, { skip });

describe.skipIf(skip)("Repositories (real Postgres)", () => {
  it.effect("migrates and round-trips a User through the real repository", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const created = yield* users.insert(
        yield* M.User.insert.makeEffect({ email: "pg@example.com", name: "PG" }),
      );
      assert.isString(created.id);
      assert.strictEqual(created.emailVerified, false);
      const found = yield* users.findById(created.id);
      assert.strictEqual(found.email, "pg@example.com");
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("enforces the (providerId, subject, issuer) unique constraint", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const accounts = yield* Repositories.AccountsRepository;
      const user = yield* users.insert(
        yield* M.User.insert.makeEffect({ email: "dupe@example.com", name: "Dupe" }),
      );
      const insert = yield* M.Account.insert.makeEffect({
        userId: user.id,
        providerId: "password",
        subject: user.id,
        issuer: "",
        passwordHash: null,
        accessToken: null,
        refreshToken: null,
      });
      yield* accounts.insert(insert);
      const failure = yield* accounts.insert(insert).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SqlError");
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  // upstream-hardening-followups ticket 01: every one of these exercises a
  // raw SQL query this ticket quoted — before the fix each failed against
  // real Postgres with `column "..." does not exist` (Postgres folds an
  // unquoted identifier to lowercase, but this table's own DDL declares
  // these columns with preserved mixed case). The SQLite suite
  // (`Repositories.test.ts`) can't catch this class of bug at all, since
  // SQLite's identifier resolution is case-insensitive regardless of
  // quoting.

  it.effect("Users.verifyEmail sets emailVerified/updatedAt via the quoted columns", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const user = yield* users.insert(
        yield* M.User.insert.makeEffect({ email: "verify@example.com", name: "V" }),
      );
      assert.strictEqual(user.emailVerified, false);
      const verified = yield* users.verifyEmail(user.id);
      assert.strictEqual(verified.emailVerified, true);
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "Accounts.findByProviderSubject/listByUser/deleteAllByUser all resolve the quoted providerId/userId columns",
    () =>
      Effect.gen(function* () {
        const users = yield* Repositories.UsersRepository;
        const accounts = yield* Repositories.AccountsRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "acct-cols@example.com", name: "A" }),
        );
        yield* accounts.insert(
          yield* M.Account.insert.makeEffect({
            userId: user.id,
            providerId: "password",
            subject: user.id,
            issuer: "",
            passwordHash: null,
            accessToken: null,
            refreshToken: null,
          }),
        );

        const found = yield* accounts.findByProviderSubject("password", user.id, "");
        assert.isTrue(Option.isSome(found));

        const listed = yield* accounts.listByUser(user.id);
        assert.strictEqual(listed.length, 1);

        yield* accounts.deleteAllByUser(user.id);
        const afterDelete = yield* accounts.listByUser(user.id);
        assert.strictEqual(afterDelete.length, 0);
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "Sessions.listByUser/deleteAllForUserExcept/deleteAllByUser all resolve the quoted userId/createdAt columns",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const users = yield* Repositories.UsersRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "sess-cols@example.com", name: "S" }),
        );
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const make = () =>
          sessions.insert(
            M.Session.insert.make({
              userId: user.id,
              secretHash: "h",
              ipAddress: null,
              userAgent: null,
              absoluteExpiresAt: future,
              idleExpiresAt: Model.Override(future),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );
        const keep = yield* make();
        yield* make();
        yield* make();

        const page = yield* sessions.listByUser(user.id, now, undefined, 10);
        assert.strictEqual(page.items.length, 3);
        assert.isTrue(Option.isNone(page.nextCursor));

        yield* sessions.deleteAllForUserExcept(user.id, keep.id);
        const afterExcept = yield* sessions.listByUser(user.id, now, undefined, 10);
        assert.strictEqual(afterExcept.items.length, 1);
        assert.strictEqual(afterExcept.items[0]?.id, keep.id);

        yield* sessions.deleteAllByUser(user.id);
        const afterAll = yield* sessions.listByUser(user.id, now, undefined, 10);
        assert.strictEqual(afterAll.items.length, 0);
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "Verification.findByIdentifier/upsertLive/tryConsume all resolve the quoted valueHash/expiresAt/consumedAt/createdAt columns",
    () =>
      Effect.gen(function* () {
        const verification = yield* Repositories.VerificationRepository;
        const now = yield* DateTime.now;
        const expiresAt = DateTime.add(now, { minutes: 15 });

        const issued = yield* verification.upsertLive(
          yield* M.VerificationToken.insert.makeEffect({
            identifier: "verify-email:pg-user",
            valueHash: "hash-1",
            expiresAt,
            consumedAt: null,
          }),
        );
        assert.strictEqual(issued.valueHash, "hash-1");

        const found = yield* verification.findByIdentifier("verify-email:pg-user");
        assert.isTrue(Option.isSome(found));

        const consumed = yield* verification.tryConsume({
          identifier: "verify-email:pg-user",
          valueHash: "hash-1",
          now,
        });
        assert.isTrue(Option.isSome(consumed));
        // PPS-003: a consumed token is history, not the live row.
        assert.isTrue(Option.isNone(yield* verification.findByIdentifier("verify-email:pg-user")));

        const replay = yield* verification.tryConsume({
          identifier: "verify-email:pg-user",
          valueHash: "hash-1",
          now,
        });
        assert.isTrue(Option.isNone(replay));
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "VerificationReservations.claim resolves the quoted expiresAt column in its upsert",
    () =>
      Effect.gen(function* () {
        const reservations = yield* Repositories.VerificationReservationsRepository;
        const now = yield* DateTime.now;
        const expiresAt = DateTime.add(now, { minutes: 5 });

        const first = yield* reservations.claim({
          identifier: "reserve:pg-user",
          expiresAt,
          now,
        });
        assert.isTrue(first);

        const second = yield* reservations.claim({
          identifier: "reserve:pg-user",
          expiresAt,
          now,
        });
        assert.isFalse(second);
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  // RRC-001: the default `ReplicationPosition` speaks Postgres LSNs. The
  // "replica" here is the primary itself (there is no streaming replica in
  // this environment), which is never in recovery, so `pg_last_wal_replay_lsn()`
  // is NULL and it can never prove it caught up — exactly the safe direction.
  it.effect(
    "ReadRouting: captureToken reads a real LSN; an eventual read then pins the primary",
    () =>
      Effect.gen(function* () {
        const replicaLive = ReadRouting.replica(SqlLive);
        const users = yield* Repositories.UsersRepository;
        const inFiber = Effect.gen(function* () {
          const router = yield* ReadRouting.makeRouter;
          assert.strictEqual(yield* router.target("eventual"), "replica"); // no token yet
          yield* ReadRouting.captureToken(
            users.insert(yield* M.User.insert.makeEffect({ email: "lsn@example.com", name: "L" })),
          );
          const token = yield* ReadRouting.CurrentCausalToken;
          assert.isTrue(Option.isSome(token));
          assert.match(Option.getOrThrow(token), /^[0-9A-F]+\/[0-9A-F]+$/);
          assert.strictEqual(yield* router.target("eventual"), "primary");
          assert.strictEqual(yield* router.target("authoritative"), "primary");
        });
        yield* inFiber.pipe(
          Effect.provideService(ReadRouting.CurrentCausalToken, Option.none()),
          Effect.provide(replicaLive),
        );
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  // `Migrator`'s Postgres ledger check (`select 'name'::regclass`) cannot decode its
  // row under @effect/sql-pg 4.0.0-rc.116 once the ledger exists, and the failure
  // wrecks the connection: a *second* migrator run on a migrated database dies.
  // A client-scoped regclass codec (README, "Postgres client configuration")
  // makes a re-run the no-op it should be.
  it.effect(
    "re-running coreMigrations on a migrated database applies nothing (regclass codec)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const again = yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
        assert.strictEqual(again.length, 0);
        // The connection is still healthy afterwards.
        const rows = yield* sql`SELECT 1 AS ok`;
        assert.strictEqual(rows.length, 1);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.effectDiscard(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                for (const table of coreTables) {
                  yield* sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
                }
                yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
              }),
            ),
            PgClient.layer({
              url: Redacted.make(postgresUrl ?? ""),
              types: regclassTypes(),
              maxConnections: 1,
            }),
          ),
        ),
      ),
  );
});

// DRS-001/SAM-006 (ADR-EA-018): the opt-in RLS backstop. The suite connects as a
// superuser, which bypasses RLS by definition, so each probe drops to a plain
// non-owner role (`SET LOCAL ROLE`) inside the tenant transaction — exactly the
// role a production application should run as.
describe.skipIf(skip)("Tenant RLS (real Postgres)", () => {
  const probeRole = "awthaq_rls_probe";

  const sessionFor = (userId: Models.UserId) =>
    M.Session.insert.make({
      userId,
      secretHash: "h",
      ipAddress: null,
      userAgent: null,
      absoluteExpiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
      idleExpiresAt: Model.Override(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z")),
      actingAsType: null,
      actingAsId: null,
      familyId: Schema.decodeUnknownSync(Models.SessionId)("rls-family"),
      supersededBy: null,
      supersededAt: null,
      reusedAt: null,
    });

  /** Runs `body` with RLS on, and always turns it off again (the tables are shared with other cases). */
  const withRls = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${probeRole}') THEN CREATE ROLE ${probeRole} NOLOGIN; END IF; END $$`,
        );
        yield* sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${probeRole}`);
        yield* TenantScope.enableRls();
      }),
      () => body,
      () => Effect.orDie(TenantScope.disableRls),
    );

  it.effect("a query inside withTenant('t1') cannot read or write t2's session rows", () =>
    withRls(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const users = yield* Repositories.UsersRepository;
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "rls@example.com", name: "RLS" }),
        );
        const one = yield* sessions.insert(sessionFor(user.id)).pipe(TenantScope.withTenant("t1"));
        const two = yield* sessions.insert(sessionFor(user.id)).pipe(TenantScope.withTenant("t2"));
        assert.strictEqual(one.tenantId, "t1");
        assert.strictEqual(two.tenantId, "t2");

        const visibleTo = (tenant: string) =>
          Effect.andThen(
            sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
            sql<{ readonly id: string }>`SELECT id FROM sessions WHERE "userId" = ${user.id}`,
          ).pipe(TenantScope.withTenant(tenant));

        assert.deepStrictEqual(
          (yield* visibleTo("t1")).map((row) => row.id),
          [one.id],
        );
        assert.deepStrictEqual(
          (yield* visibleTo("t2")).map((row) => row.id),
          [two.id],
        );

        // No tenant in scope: fail-open by design (single-tenant, migrations, maintenance).
        const unscoped = yield* sql.withTransaction(
          Effect.andThen(
            sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
            sql<{ readonly id: string }>`SELECT id FROM sessions WHERE "userId" = ${user.id}`,
          ),
        );
        assert.strictEqual(unscoped.length, 2);

        // Another tenant's row can be neither updated nor forged.
        const crossTenantWrite = yield* Effect.andThen(
          sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
          sql`UPDATE sessions SET "userAgent" = 'x' WHERE id = ${two.id} RETURNING id`,
        ).pipe(TenantScope.withTenant("t1"));
        assert.strictEqual(crossTenantWrite.length, 0);
        const forgedInsert = yield* Effect.andThen(
          sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
          sql`INSERT INTO sessions ${sql.insert({
            id: "forged",
            userId: user.id,
            secretHash: "h",
            absoluteExpiresAt: new Date("2099-01-01T00:00:00Z"),
            idleExpiresAt: new Date("2099-01-01T00:00:00Z"),
            createdAt: new Date(),
            authenticatedAt: new Date(),
            lastActiveAt: new Date(),
            familyId: "forged",
            tenantId: "t2",
          })}`,
        ).pipe(TenantScope.withTenant("t1"), Effect.flip);
        assert.strictEqual(forgedInsert._tag, "SqlError");
      }),
    ).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("enableRls and disableRls are idempotent, and the directory tables are opt-in", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rlsOn = (table: string) =>
        sql<{ readonly relrowsecurity: boolean }>`
          SELECT relrowsecurity FROM pg_class WHERE relname = ${table} AND relnamespace = 'public'::regnamespace
        `.pipe(Effect.map((rows) => rows[0]?.relrowsecurity ?? false));

      yield* TenantScope.enableRls();
      yield* TenantScope.enableRls();
      assert.isTrue(yield* rlsOn("sessions"));
      assert.isFalse(yield* rlsOn("users"));
      yield* TenantScope.enableRls({ includeDirectory: true });
      assert.isTrue(yield* rlsOn("users"));
      yield* TenantScope.disableRls;
      yield* TenantScope.disableRls;
      assert.isFalse(yield* rlsOn("sessions"));
      assert.isFalse(yield* rlsOn("users"));
    }).pipe(Effect.provide(RepositoriesLive)),
  );
});
