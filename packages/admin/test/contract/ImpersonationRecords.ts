// Plan 25 ticket 15 (ADR-EA-041 decision 9): `ImpersonationRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. ALF-005 (F7): an episode row and its ledger link are written as one step on
// every adapter, so `verifyChain` never sees one without the other, however many writers race it.
import { Tenant, Users } from "@awthaq/core";
import { TenantScope, TenantScoped } from "@awthaq/sql";
import { RecordsContract, type TestAuth, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../../src/Admin.ts";
import * as ImpersonationRecords from "../../src/ImpersonationRecords.ts";

/** The maintenance witness the suite presents (the same shape `Admin` mints). */
const grant = TenantScoped.crossTenant("test: maintenance over every tenant");

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave inside a write. Without it a memory
 * write (whose crypto is synchronous) finishes inside one scheduler slice and no race shows. (Effect 4.1.2 stalls
 * with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

/** How many times each racing reader calls `verifyChain`, so reads land throughout the writes. */
const READS = 8;

const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const adminId = Users.UserId("admin-1");
const targetId = Users.UserId("target-1");

/** IDS-004: every row records its hard expiry; a generous default keeps unrelated cases unaffected. */
const farFuture = Effect.map(DateTime.now, (now) => DateTime.addDuration(now, Duration.days(1)));

const seed = (
  records: ImpersonationRecords.ImpersonationRecordsShape,
  sessionId: string,
  reason = "test",
) =>
  Effect.flatMap(farFuture, (expiresAt) =>
    records.create({ adminUserId: adminId, targetUserId: targetId, sessionId, reason, expiresAt }),
  );

const intact = (records: ImpersonationRecords.ImpersonationRecordsShape) =>
  Effect.map(records.verifyChain(grant), (broken) => {
    assert.deepStrictEqual(broken, Option.none());
  });

/** Every broken `verifyChain` answer taken while `writers` ran beside them. */
const verifiedDuring = <A, E, R>(
  records: ImpersonationRecords.ImpersonationRecordsShape,
  writers: ReadonlyArray<Effect.Effect<A, E, R>>,
) =>
  Effect.all(
    [
      ...writers.map((writer) => Effect.as(Effect.exit(writer), [])),
      ...Array.from({ length: RecordsContract.CONCURRENCY }, () =>
        Effect.forEach(Array.from({ length: READS }), () => records.verifyChain(grant)),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((answers) => answers.flat().filter(Option.isSome)),
    fineGrained,
  );

/** A raw rewrite's rejection: a `SqlError` wraps the driver's own error; the trigger's message lives a few `cause`s down. */
const rejection = (error: unknown): string => {
  const messages: Array<string> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

/** What a DBA bypassing the triggers does. Postgres has one guard trigger per table, SQLite one per rule. */
const dropTrigger = (sqlite: string, pg: { readonly name: string; readonly table: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.onDialectOrElse({
      pg: () => sql.unsafe(`DROP TRIGGER IF EXISTS ${pg.name} ON ${pg.table}`),
      orElse: () => sql.unsafe(`DROP TRIGGER ${sqlite}`),
    });
  });

const seedTwo = Effect.gen(function* () {
  const records = yield* ImpersonationRecords.ImpersonationRecords;
  const first = yield* seed(records, "session-a", "first");
  yield* TestClock.adjust(Duration.millis(1));
  const second = yield* seed(records, "session-b", "second");
  yield* records.endEpisode("session-a", "self");
  return { records, first, second };
});

// Plan 05: the tenant-isolation conformance case.
let isolationCounter = 0;
const isolationCase: TestAuth.TableCase<
  ImpersonationRecords.ImpersonationRecordsShape,
  string,
  ImpersonationRecords.ImpersonationRecords
> = {
  table: "admin_impersonation",
  insert: Effect.gen(function* () {
    const records = yield* ImpersonationRecords.ImpersonationRecords;
    isolationCounter += 1;
    return (yield* seed(records, `isolation-${isolationCounter}`)).sessionId;
  }),
  methods: {
    create: { insert: true },
    findBySessionId: {
      scoped: {
        run: (sessionId) =>
          Effect.flatMap(ImpersonationRecords.ImpersonationRecords, (records) =>
            Effect.map(records.findBySessionId(sessionId), Option.isSome),
          ),
      },
    },
    endEpisode: {
      scoped: {
        run: (sessionId) =>
          Effect.flatMap(ImpersonationRecords.ImpersonationRecords, (records) =>
            records.endEpisode(sessionId, "self").pipe(
              Effect.as(true),
              Effect.catchTag("ImpersonationRecordNotFound", () => Effect.succeed(false)),
            ),
          ),
      },
    },
    list: {
      scoped: {
        run: (sessionId) =>
          Effect.flatMap(ImpersonationRecords.ImpersonationRecords, (records) =>
            Effect.map(records.list(), (page) =>
              page.items.some((row) => row.sessionId === sessionId),
            ),
          ),
      },
    },
    closeExpired: {
      crossTenant: {
        run: (sessionId) =>
          Effect.flatMap(ImpersonationRecords.ImpersonationRecords, (records) =>
            Effect.flatMap(DateTime.now, (now) =>
              Effect.map(
                records.closeExpired(grant, DateTime.addDuration(now, Duration.days(2))),
                (closed) => closed.some((row) => row.sessionId === sessionId),
              ),
            ),
          ),
      },
    },
    verifyChain: {
      crossTenant: {
        run: () =>
          Effect.flatMap(ImpersonationRecords.ImpersonationRecords, (records) =>
            Effect.map(records.verifyChain(grant), Option.isNone),
          ),
      },
    },
  },
};

export const impersonationRecords = RecordsContract.suite(
  ImpersonationRecords.ImpersonationRecords,
  {
    operations: {
      create: {
        atomic: [
          {
            name: "create then findBySessionId round-trips every field",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              const expiresAt = DateTime.addDuration(yield* DateTime.now, Duration.hours(1));
              yield* records.create({
                adminUserId: adminId,
                targetUserId: targetId,
                sessionId: "session-1",
                reason: "reproducing a bug report",
                expiresAt,
              });
              const found = yield* records.findBySessionId("session-1");
              assert.isTrue(Option.isSome(found));
              if (Option.isSome(found)) {
                assert.strictEqual(found.value.adminUserId, adminId);
                assert.strictEqual(found.value.targetUserId, targetId);
                assert.strictEqual(found.value.reason, "reproducing a bug report");
                assert.isTrue(Option.isNone(found.value.endedAt));
                assert.isTrue(Option.isNone(found.value.endedBy));
                assert.deepStrictEqual(found.value.expiresAt, Option.some(expiresAt));
              }
              yield* intact(records);
            }),
          },
          {
            name: "IDS-002: create stamps the ambient tenant, None leaves it untenanted",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              const tenanted = yield* seed(records, "s-a").pipe(Tenant.withTenant("org-a"));
              assert.deepStrictEqual(tenanted.tenantId, Option.some("org-a"));
              const plain = yield* seed(records, "s-plain");
              assert.isTrue(Option.isNone(plain.tenantId));
              const reread = yield* records
                .findBySessionId("s-a")
                .pipe(Tenant.withTenant("org-a"), Effect.map(Option.getOrThrow));
              assert.deepStrictEqual(reread.tenantId, Option.some("org-a"));
            }),
          },
          {
            name: "an interrupted create leaves its row and its link together, or neither",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              // Interrupt at every point of the write, from before it starts until it has finished.
              let finished = false;
              for (let depth = 0; !finished; depth++) {
                const fiber = yield* Effect.forkChild(
                  fineGrained(seed(records, `interrupted-${depth}`)),
                );
                for (let step = 0; step < depth; step++) yield* Effect.yieldNow;
                finished = fiber.pollUnsafe() !== undefined;
                yield* Fiber.interrupt(fiber);
                yield* intact(records);
              }
            }),
          },
        ],
        race: [
          {
            name: "8 creates racing verifyChain never report a break",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              const breaks = yield* verifiedDuring(
                records,
                Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                  seed(records, `racing-${n}`),
                ),
              );
              assert.deepStrictEqual(breaks, []);
              assert.strictEqual((yield* records.list()).items.length, RecordsContract.CONCURRENCY);
              yield* intact(records);
            }),
          },
        ],
      },
      findBySessionId: {
        read: [
          {
            name: "None for an unknown session id",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              assert.isTrue(Option.isNone(yield* records.findBySessionId("does-not-exist")));
            }),
          },
          {
            name: "IDS-002: a witness reaches another tenant's episode; without one it is not found",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              yield* seed(records, "s-a").pipe(Tenant.withTenant("org-a"));
              const plain = yield* records.findBySessionId("s-a").pipe(Tenant.withTenant("org-b"));
              assert.isTrue(Option.isNone(plain));
              const witnessed = yield* records
                .findBySessionId("s-a", grant)
                .pipe(Tenant.withTenant("org-b"));
              assert.isTrue(Option.isSome(witnessed));
              const listed = yield* records.list({}, grant).pipe(Tenant.withTenant("org-b"));
              assert.deepStrictEqual(
                listed.items.map((row) => row.sessionId),
                ["s-a"],
              );
              const ended = yield* records
                .endEpisode("s-a", "forcedByAdmin", grant)
                .pipe(Tenant.withTenant("org-b"));
              assert.deepStrictEqual(ended.endedBy, Option.some("forcedByAdmin"));
              yield* intact(records);
            }),
          },
        ],
      },
      endEpisode: {
        atomic: [
          {
            name: "sets endedAt/endedBy exactly once",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              yield* seed(records, "session-end");
              const ended = yield* records.endEpisode("session-end", "self");
              assert.isTrue(Option.isSome(ended.endedAt));
              assert.deepStrictEqual(ended.endedBy, Option.some("self"));
              const second = yield* records
                .endEpisode("session-end", "forcedByAdmin")
                .pipe(Effect.flip);
              assert.strictEqual(second._tag, "ImpersonationRecordNotFound");
              yield* intact(records);
            }),
          },
          {
            name: "fails for an unknown session id",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              const failure = yield* records.endEpisode("does-not-exist", "self").pipe(Effect.flip);
              assert.strictEqual(failure._tag, "ImpersonationRecordNotFound");
            }),
          },
        ],
        race: [
          {
            name: "8 ends of one episode racing verifyChain: one wins, never a break",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              yield* seed(records, "contested");
              const outcomes: Array<boolean> = [];
              const breaks = yield* verifiedDuring(
                records,
                Array.from({ length: RecordsContract.CONCURRENCY }, () =>
                  records.endEpisode("contested", "self").pipe(
                    Effect.as(true),
                    Effect.catchTag("ImpersonationRecordNotFound", () => Effect.succeed(false)),
                    Effect.tap((won) => Effect.sync(() => outcomes.push(won))),
                  ),
                ),
              );
              assert.deepStrictEqual(breaks, []);
              assert.strictEqual(outcomes.filter((won) => won).length, 1);
              yield* intact(records);
            }),
          },
        ],
      },
      closeExpired: {
        atomic: [
          {
            name: "IDS-004: closes only past-expiry open episodes, once, as expired",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              const start = yield* DateTime.now;
              for (const [sessionId, expiresIn] of [
                ["short", Duration.minutes(10)],
                ["long", Duration.hours(5)],
                ["already-ended", Duration.minutes(5)],
              ] satisfies ReadonlyArray<readonly [string, Duration.Duration]>) {
                yield* records.create({
                  adminUserId: adminId,
                  targetUserId: targetId,
                  sessionId,
                  reason: sessionId,
                  expiresAt: DateTime.addDuration(start, expiresIn),
                });
              }
              yield* records.endEpisode("already-ended", "self");

              yield* TestClock.adjust(Duration.hours(1));
              const closed = yield* records.closeExpired(grant, yield* DateTime.now);
              assert.deepStrictEqual(
                closed.map((row) => row.sessionId),
                ["short"],
              );
              assert.deepStrictEqual(closed[0]?.endedBy, Option.some("expired"));
              assert.deepStrictEqual(
                closed[0]?.endedAt,
                Option.some(DateTime.addDuration(start, Duration.minutes(10))),
              );
              assert.strictEqual(
                (yield* records.closeExpired(grant, yield* DateTime.now)).length,
                0,
              );

              const short = yield* records.findBySessionId("short");
              assert.isTrue(Option.isSome(short) && Option.isSome(short.value.endedAt));
              const long = yield* records.findBySessionId("long");
              assert.isTrue(Option.isSome(long) && Option.isNone(long.value.endedAt));
              // An episode ended by another path keeps its original outcome.
              const ended = yield* records.findBySessionId("already-ended");
              assert.isTrue(Option.isSome(ended));
              if (Option.isSome(ended))
                assert.deepStrictEqual(ended.value.endedBy, Option.some("self"));
              yield* intact(records);
            }),
          },
          {
            name: "IDS-002: maintenance over every tenant",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              const start = yield* DateTime.now;
              for (const tenant of ["org-a", "org-b"]) {
                yield* records
                  .create({
                    adminUserId: adminId,
                    targetUserId: targetId,
                    sessionId: `s-${tenant}`,
                    reason: "r",
                    expiresAt: DateTime.addDuration(start, Duration.minutes(1)),
                  })
                  .pipe(Tenant.withTenant(tenant));
              }
              yield* TestClock.adjust(Duration.minutes(2));
              const closed = yield* records
                .closeExpired(grant, yield* DateTime.now)
                .pipe(Tenant.withTenant("org-a"));
              assert.strictEqual(closed.length, 2);
              yield* intact(records);
            }),
          },
        ],
        race: [
          {
            name: "8 sweeps racing verifyChain close each expired episode once, never a break",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              const start = yield* DateTime.now;
              for (let n = 0; n < 3; n++) {
                yield* records.create({
                  adminUserId: adminId,
                  targetUserId: targetId,
                  sessionId: `expiring-${n}`,
                  reason: "r",
                  expiresAt: DateTime.addDuration(start, Duration.minutes(1)),
                });
              }
              yield* TestClock.adjust(Duration.minutes(2));
              const now = yield* DateTime.now;
              const closedCounts: Array<number> = [];
              const breaks = yield* verifiedDuring(
                records,
                Array.from({ length: RecordsContract.CONCURRENCY }, () =>
                  records
                    .closeExpired(grant, now)
                    .pipe(
                      Effect.tap((closed) => Effect.sync(() => closedCounts.push(closed.length))),
                    ),
                ),
              );
              assert.deepStrictEqual(breaks, []);
              assert.strictEqual(
                closedCounts.reduce((sum, count) => sum + count, 0),
                3,
              );
              yield* intact(records);
            }),
          },
        ],
      },
      list: {
        read: [
          {
            name: "full history newest-first, and active-only excludes ended rows",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              yield* seed(records, "session-older", "first");
              yield* TestClock.adjust(Duration.millis(1));
              yield* seed(records, "session-newer", "second");
              yield* records.endEpisode("session-older", "forcedByAdmin");

              const all = (yield* records.list()).items;
              assert.deepStrictEqual(
                all.map((row) => row.sessionId),
                ["session-newer", "session-older"],
              );
              const active = (yield* records.list({ active: true })).items;
              assert.deepStrictEqual(
                active.map((row) => row.sessionId),
                ["session-newer"],
              );
            }),
          },
          {
            name: "ESS-006: pages newest-first with a stable cursor across equal startedAt",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              // Five rows at the same (test-clock) instant: only the id tiebreak orders them.
              const created: Array<ImpersonationRecords.ImpersonationRecord> = [];
              for (const n of [1, 2, 3, 4, 5]) created.push(yield* seed(records, `session-${n}`));

              const seen: Array<string> = [];
              let cursor: ImpersonationRecords.ImpersonationCursor | undefined = undefined;
              let pages = 0;
              for (;;) {
                const page: ImpersonationRecords.ImpersonationPage = yield* records.list({
                  limit: 2,
                  ...(cursor === undefined ? {} : { cursor }),
                });
                pages++;
                assert.isAtMost(page.items.length, 2);
                seen.push(...page.items.map((row) => row.sessionId));
                if (Option.isNone(page.nextCursor)) break;
                cursor = page.nextCursor.value;
              }
              assert.strictEqual(pages, 3);
              assert.deepStrictEqual(
                seen,
                [...created].sort((a, b) => codeUnit(b.id, a.id)).map((row) => row.sessionId),
              );
            }),
          },
          {
            name: "ESS-006: every page size traverses the exact newest-first order across ties",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              // Three rows at T0, one at T1, three at T2: only the id tiebreak orders a group.
              const created: Array<ImpersonationRecords.ImpersonationRecord> = [];
              for (const [group, count] of [3, 1, 3].entries()) {
                if (group > 0) yield* TestClock.adjust(Duration.millis(1));
                for (let n = 0; n < count; n++)
                  created.push(yield* seed(records, `session-${group}-${n}`));
              }
              const expected = created
                .map((row) => ({
                  id: row.id,
                  sessionId: row.sessionId,
                  at: DateTime.toEpochMillis(row.startedAt),
                }))
                .sort((a, b) => b.at - a.at || codeUnit(b.id, a.id))
                .map((row) => row.sessionId);
              for (const limit of [1, 2, 3, 4, 5, 6, 7, 8]) {
                const seen: Array<string> = [];
                let cursor: ImpersonationRecords.ImpersonationCursor | undefined = undefined;
                let pages = 0;
                for (;;) {
                  const page: ImpersonationRecords.ImpersonationPage = yield* records.list({
                    limit,
                    ...(cursor === undefined ? {} : { cursor }),
                  });
                  pages++;
                  assert.isAtMost(page.items.length, limit);
                  seen.push(...page.items.map((row) => row.sessionId));
                  if (Option.isNone(page.nextCursor)) break;
                  cursor = page.nextCursor.value;
                }
                assert.deepStrictEqual(seen, expected, `limit ${limit}`);
                assert.strictEqual(pages, Math.ceil(7 / limit), `limit ${limit}`);
              }
            }),
          },
          {
            name: "ESS-006: an in-process limit is normalised like Users.list",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              for (const n of [1, 2, 3]) yield* seed(records, `session-${n}`);
              const sized = (limit: number) =>
                Effect.map(records.list({ limit }), (page) => [
                  page.items.length,
                  Option.isSome(page.nextCursor),
                ]);
              assert.deepStrictEqual(yield* sized(0), [1, true]);
              assert.deepStrictEqual(yield* sized(-3), [1, true]);
              assert.deepStrictEqual(yield* sized(2.5), [2, true]);
              assert.deepStrictEqual(yield* sized(Number.NaN), [3, false]);
              assert.deepStrictEqual(yield* sized(10_000), [3, false]);
            }),
          },
          {
            name: "ESS-006: the last page carries no cursor and an exact-limit page does not invent one",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              yield* seed(records, "session-a");
              yield* seed(records, "session-b");
              const page = yield* records.list({ limit: 2 });
              assert.strictEqual(page.items.length, 2);
              assert.isTrue(Option.isNone(page.nextCursor));
            }),
          },
        ],
      },
      verifyChain: {
        read: [
          {
            name: "ALF-005: clean across create, end, close-expired and list",
            run: Effect.gen(function* () {
              const records = yield* ImpersonationRecords.ImpersonationRecords;
              yield* intact(records);
              const start = yield* DateTime.now;
              yield* records.create({
                adminUserId: adminId,
                targetUserId: targetId,
                sessionId: "s-self",
                reason: "one",
                expiresAt: DateTime.addDuration(start, Duration.hours(5)),
              });
              yield* records.create({
                adminUserId: adminId,
                targetUserId: targetId,
                sessionId: "s-expiring",
                reason: "two",
                expiresAt: DateTime.addDuration(start, Duration.minutes(1)),
              });
              yield* records.endEpisode("s-self", "self");
              yield* TestClock.adjust(Duration.minutes(2));
              yield* records.closeExpired(grant, yield* DateTime.now);
              yield* intact(records);
            }),
          },
        ],
      },
    },
    // ALF-005: the database itself refuses the casual rewrite, and the hash chain makes a forger who bypasses the
    // triggers (a DBA, `DROP TRIGGER`) detectable. Postgres runs its plpgsql triggers, shipped in the same migration.
    sql: [
      {
        name: "ALF-005: a raw UPDATE of an immutable column is rejected by the trigger",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { first } = yield* seedTwo;
          const failure =
            yield* sql`UPDATE admin_impersonation SET reason = 'forged' WHERE id = ${first.id}`.pipe(
              Effect.flip,
            );
          assert.include(rejection(failure), "append-only");
        }),
      },
      {
        name: "ALF-005/IDS-002: the tenant column is frozen with the rest of an episode's start facts",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const records = yield* ImpersonationRecords.ImpersonationRecords;
          const episode = yield* seed(records, "session-t").pipe(Tenant.withTenant("org-a"));
          const failure =
            yield* sql`UPDATE admin_impersonation SET "tenantId" = 'org-b' WHERE id = ${episode.id}`.pipe(
              Effect.flip,
            );
          assert.include(rejection(failure), "append-only");
          yield* intact(records);
        }),
      },
      {
        name: "ALF-005: a raw DELETE is rejected by the trigger",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { first } = yield* seedTwo;
          const failure = yield* sql`DELETE FROM admin_impersonation WHERE id = ${first.id}`.pipe(
            Effect.flip,
          );
          assert.include(rejection(failure), "append-only");
        }),
      },
      {
        name: "ALF-005: an ended episode's endedAt/endedBy can no longer be rewritten",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { first } = yield* seedTwo;
          const failure =
            yield* sql`UPDATE admin_impersonation SET "endedBy" = 'expired' WHERE id = ${first.id}`.pipe(
              Effect.flip,
            );
          assert.include(rejection(failure), "append-only");
        }),
      },
      {
        name: "ALF-005: the chain ledger itself rejects UPDATE and DELETE",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedTwo;
          const update = yield* sql`UPDATE admin_impersonation_chain SET payload = 'x'`.pipe(
            Effect.flip,
          );
          assert.include(rejection(update), "append-only");
          const remove = yield* sql`DELETE FROM admin_impersonation_chain`.pipe(Effect.flip);
          assert.include(rejection(remove), "append-only");
        }),
      },
      {
        name: "ALF-005: verifyChain detects a row rewritten with the triggers disabled, naming the episode",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { records, second } = yield* seedTwo;
          yield* intact(records);
          yield* dropTrigger("admin_impersonation_immutable", {
            name: "admin_impersonation_guard",
            table: "admin_impersonation",
          });
          yield* sql`UPDATE admin_impersonation SET reason = 'forged' WHERE id = ${second.id}`;
          const broken = yield* records.verifyChain(grant);
          // `second` was the second link written (`first`'s start, `second`'s start, `first`'s end).
          assert.deepStrictEqual(
            broken,
            Option.some({ seq: Option.some(2), episodeId: second.id, reason: "row-mismatch" }),
          );
        }),
      },
      {
        name: "ALF-005: verifyChain detects a deleted episode row and a rewritten ledger entry",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { records, first, second } = yield* seedTwo;
          yield* dropTrigger("admin_impersonation_no_delete", {
            name: "admin_impersonation_guard",
            table: "admin_impersonation",
          });
          yield* sql`DELETE FROM admin_impersonation WHERE id = ${second.id}`;
          const missing = yield* records.verifyChain(grant);
          assert.isTrue(Option.isSome(missing));
          if (Option.isSome(missing)) {
            assert.strictEqual(missing.value.episodeId, second.id);
            assert.strictEqual(missing.value.reason, "row-missing");
          }
          yield* dropTrigger("admin_impersonation_chain_no_update", {
            name: "admin_impersonation_chain_guard",
            table: "admin_impersonation_chain",
          });
          yield* sql`UPDATE admin_impersonation_chain SET payload = 'forged' WHERE "episodeId" = ${first.id} AND kind = 'started'`;
          assert.deepStrictEqual(
            yield* records.verifyChain(grant),
            Option.some({ seq: Option.some(1), episodeId: first.id, reason: "chain-broken" }),
          );
        }),
      },
      {
        name: "ALF-005: a row inserted straight into the table with no ledger link is reported",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { records } = yield* seedTwo;
          yield* sql`INSERT INTO admin_impersonation (id, "adminUserId", "targetUserId", "sessionId", reason, "startedAt", "expiresAt", "endedAt", "endedBy")
            VALUES ('smuggled', 'a', 'b', 'session-x', 'r', '1970-01-01T00:00:00.000Z', NULL, NULL, NULL)`;
          assert.deepStrictEqual(
            yield* records.verifyChain(grant),
            Option.some({ seq: Option.none(), episodeId: "smuggled", reason: "row-unledgered" }),
          );
        }),
      },
      {
        // Plan 05: without `TenantScoped.lift` the policy confines `verifyChain` to the request's tenant while the
        // ledger spans every tenant, and an intact chain reports `row-missing`. Postgres only (SQLite has no RLS).
        name: "plan 05: an intact chain stays intact inside TenantScope.withTenant with RLS on (Postgres)",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const probeRole = "awthaq_rls_probe";
          yield* sql.onDialectOrElse({
            orElse: () => Effect.void,
            pg: () =>
              Effect.acquireUseRelease(
                Effect.gen(function* () {
                  const records = yield* ImpersonationRecords.ImpersonationRecords;
                  yield* seed(records, "rls-a").pipe(Tenant.withTenant("org-a"));
                  yield* seed(records, "rls-b").pipe(Tenant.withTenant("org-b"));
                  yield* TestSql.prepareRlsProbe(probeRole);
                  yield* TenantScope.enableRls({
                    plugins: Object.entries(Admin.Admin.tenancy).map(([table, declaration]) => ({
                      plugin: "admin",
                      table,
                      tenancy: declaration.tenancy,
                    })),
                  });
                }),
                () =>
                  Effect.gen(function* () {
                    const records = yield* ImpersonationRecords.ImpersonationRecords;
                    const broken = yield* Effect.andThen(
                      sql.unsafe(`SET LOCAL ROLE ${probeRole}`),
                      records.verifyChain(grant),
                    ).pipe(TenantScope.withTenant("org-a"));
                    assert.isTrue(Option.isNone(broken));
                  }),
                () => Effect.orDie(TenantScope.disableRls),
              ),
          });
        }),
      },
    ],
    tenancy: { covers: ["admin_impersonation"], cases: [isolationCase] },
  },
);
