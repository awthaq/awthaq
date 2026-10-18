// Plan 02 / plan 16: what only the SQL adapter of `VerificationStore` can show. What every adapter
// must do is `StoreContract.verification` (`packages/test/test/StoreContract.*.test.ts`, also on
// Postgres under `pnpm test:pg`); this is the failure mapping (injected at the SQL client,
// `FaultySql`), the row a miss is charged to, the raw rows (payload text, tenant stamp) and the
// query plan the adapter's lookup relies on.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tenant, VerificationStore } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { UnknownError } from "effect/unstable/sql/SqlError";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as VerificationStoreSql from "../src/VerificationStoreSql.ts";
import * as FaultySql from "./support/FaultySql.ts";

const migrate = Migrator.make({})({ loader: CoreMigrations.coreMigrations });

/** The store over a client whose statements fail on demand, after the schema is applied. */
const FaultyStore = (() => {
  const Faulty = FaultySql.layer(SqliteClient.layer({ filename: ":memory:" }));
  return VerificationStoreSql.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(migrate).pipe(Layer.provide(Faulty))),
    Layer.provideMerge(Faulty),
  );
})();

const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);
const tokenId = Schema.decodeUnknownSync(Models.VerificationTokenId);

const newToken = (
  id: string,
  identifier: string,
  valueHash: string,
  options: { readonly maxAttempts?: number; readonly payload?: string } = {},
) => ({
  id: tokenId(id),
  identifier,
  userId: Option.none<Models.UserId>(),
  valueHash,
  createdAt: at(0),
  expiresAt: at(10),
  payloadJson: Option.fromNullishOr(options.payload),
  maxAttempts: Option.fromNullishOr(options.maxAttempts),
});

describe("VerificationStoreSql failure mapping (MA-004)", () => {
  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({
        count: Number.POSITIVE_INFINITY,
        reason: new UnknownError({ cause: new Error("database is down") }),
      });
      const failures = {
        upsertLive: yield* store.upsertLive(newToken("t1", "x", "h")).pipe(Effect.flip),
        present: yield* store
          .present({ identifier: "x", valueHash: "h", now: at(1), hold: false })
          .pipe(Effect.flip),
        reserve: yield* store
          .reserve({ identifier: "x", now: at(0), expiresAt: at(1) })
          .pipe(Effect.flip),
        deleteByUser: yield* store
          .deleteByUser(Schema.decodeUnknownSync(Models.UserId)("u1"))
          .pipe(Effect.flip),
        purgeExpired: yield* store.purgeExpired(at(100)).pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `VerificationStore.${primitive}`);
      }
    }).pipe(Effect.provide(FaultyStore)),
  );
});

// SOS-004: a miss is charged to the row it was judged against. A reissue replaces the live row (and
// its id) while the miss sits between its claim and its spend; the spend finds nothing of the old
// row and must not touch the new token. The reissue is a second connection to the same database
// file, landing just before the statement that spends the attempt.
describe("VerificationStoreSql misses (SOS-004)", () => {
  const identifier = "email-otp:reissue-race@example.com";

  it.effect("a reissue racing a miss never charges the new token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-verification-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const filename = join(dir, "auth.db");
        const Faulty = FaultySql.layer(SqliteClient.layer({ filename }));
        const first = yield* Layer.build(
          VerificationStoreSql.layer.pipe(
            Layer.provideMerge(Layer.effectDiscard(migrate).pipe(Layer.provide(Faulty))),
            Layer.provideMerge(Faulty),
          ),
        );
        const second = yield* Layer.build(
          VerificationStoreSql.layer.pipe(Layer.provide(SqliteClient.layer({ filename }))),
        );
        const primary = Context.get(first, VerificationStore.VerificationStore);
        const rival = Context.get(second, VerificationStore.VerificationStore);
        const faults = Context.get(first, FaultySql.FaultControl);

        yield* primary.upsertLive(
          newToken("original", identifier, "h-original", { maxAttempts: 2 }),
        );
        // One wrong guess misses; the reissue lands before the statement that spends the attempt.
        yield* faults.beforeNext({
          matching: /SET attempts = attempts \+ 1/,
          run: rival
            .upsertLive(newToken("reissued", identifier, "h-new", { maxAttempts: 2 }))
            .pipe(Effect.orDie, Effect.asVoid),
        });
        const missed = yield* primary.present({
          identifier,
          valueHash: "000000",
          now: at(1),
          hold: false,
        });
        assert.strictEqual(missed._tag, "Miss");
        // Not vacuous: the reissue really landed between the claim and the spend.
        const live = yield* Context.get(first, SqlClient.SqlClient)<{ readonly id: string }>`
          SELECT id FROM verification_tokens WHERE identifier = ${identifier} AND "consumedAt" IS NULL`;
        assert.deepStrictEqual(
          live.map((row) => row.id),
          ["reissued"],
        );
        // The reissued token (budget 2) was not charged for it: one more wrong guess still leaves it
        // usable, and the right hash claims it.
        const second2 = yield* primary.present({
          identifier,
          valueHash: "111111",
          now: at(2),
          hold: false,
        });
        assert.strictEqual(second2._tag, "Miss");
        const claimed = yield* primary.present({
          identifier,
          valueHash: "h-new",
          now: at(3),
          hold: false,
        });
        assert.strictEqual(claimed._tag, "Hit");
      }),
    ),
  );
});

describe("VerificationStoreSql rows (SQLite)", () => {
  it.effect(
    "BEH-EA-122: a token with no payload stores the literal null and reads back None; a payload is stored as given",
    () =>
      Effect.gen(function* () {
        const store = yield* VerificationStore.VerificationStore;
        const sql = yield* SqlClient.SqlClient;
        const json = JSON.stringify({ codeVerifier: "abc", nonce: "xyz" });
        const withPayload = yield* store.upsertLive(
          newToken("p1", "oauth.flow:1", "hash-1", { payload: json }),
        );
        assert.deepStrictEqual(withPayload.payloadJson, Option.some(json));
        const without = yield* store.upsertLive(newToken("p2", "verify-email:user-2", "hash-2"));
        assert.deepStrictEqual(without.payloadJson, Option.none());
        const rows = yield* sql<{ readonly payload: string }>`
          SELECT payload FROM verification_tokens WHERE id = ${"p1"} OR id = ${"p2"} ORDER BY id`;
        assert.deepStrictEqual(
          rows.map((row) => row.payload),
          [json, "null"],
        );
      }).pipe(Effect.provide(FaultyStore)),
  );

  it.effect("DRS-001: upsertLive and reserve stamp the ambient tenant, NULL when none", () =>
    Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      const sql = yield* SqlClient.SqlClient;
      const tenantOf = (table: string, column: string, key: string) =>
        sql
          .unsafe<{ readonly tenantId: string | null }>(
            `SELECT "tenantId" FROM ${table} WHERE ${column} = '${key}'`,
          )
          .pipe(Effect.map((rows) => rows.map((row) => row.tenantId)));
      yield* Effect.all([
        store.upsertLive(newToken("d1", "reset-password:t1", "h")),
        store.reserve({ identifier: "signup:t1", now: at(0), expiresAt: at(5) }),
      ]).pipe(Tenant.withTenant("tenant-1"));
      yield* store.upsertLive(newToken("d2", "reset-password:plain", "h"));
      yield* store.reserve({ identifier: "signup:plain", now: at(0), expiresAt: at(5) });
      assert.deepStrictEqual(
        yield* tenantOf("verification_tokens", "identifier", "reset-password:t1"),
        ["tenant-1"],
      );
      assert.deepStrictEqual(
        yield* tenantOf("verification_reservations", "identifier", "signup:t1"),
        ["tenant-1"],
      );
      assert.deepStrictEqual(
        yield* tenantOf("verification_tokens", "identifier", "reset-password:plain"),
        [null],
      );
      assert.deepStrictEqual(
        yield* tenantOf("verification_reservations", "identifier", "signup:plain"),
        [null],
      );
    }).pipe(Effect.provide(FaultyStore)),
  );

  // PPS-003: the live lookup is served by the partial unique live-identifier index with no temp
  // b-tree. This is the exact statement `present` runs first.
  it.effect("PPS-003: the live-identifier lookup uses the partial unique index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM verification_tokens WHERE identifier = ? AND "consumedAt" IS NULL`,
        ["verify-email:user-1"],
      );
      const detail = plan.map((row) => row.detail).join(" | ");
      assert.include(detail, "verification_tokens_live_identifier");
      assert.notInclude(detail, "TEMP B-TREE");
    }).pipe(Effect.provide(FaultyStore)),
  );
});
