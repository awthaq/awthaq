// @awthaq/test — StoreContract
//
// Plan 02 (ADR-EA-041): the bar any adapter of a core store port must clear. The domain services
// (`Sessions`, `Users`, `Accounts`, `Verification`, `AuditLog`) are written once over a port whose
// primitives are atomic by contract; a store backend (the `Ref` adapters in `@awthaq/ports`, the
// SQL adapters in `@awthaq/sql`, a third party's KV `SessionStore`) is acceptable when every case
// below passes on it, concurrency cases included.
//
// Cases are data: a name and an `Effect` over the port, so this module needs no test runner. A
// runner (`run`) is handed the host's `describe`/`it`, builds a FRESH layer for every case (a new
// `Ref`, a new `:memory:` database or a freshly reset Postgres schema) and fails the case with
// the error the effect failed with. Cases never read the ambient clock for expiry: every store
// primitive takes the instant it judges at, so a case fixes the time itself and passes on any
// runner. A "concurrent" case runs `CONCURRENCY` calls under `Effect.all(..., { concurrency:
// "unbounded" })` and asserts exact counts.
//
// Each port's cases are added with its adapters: `auditLog`, `verification`, `accounts`, `users` and
// `sessions`.

import assert from "node:assert/strict";
import {
  AccountStore,
  AuditLogStore,
  Ids,
  SessionStore,
  SqlTransaction,
  Tenant,
  UserStore,
  VerificationStore,
} from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { TestFramework } from "./TestFramework.ts";

/** One named property of a store port. `R` is the port (and whatever the case needs besides). */
export interface Case<R> {
  readonly name: string;
  readonly run: Effect.Effect<void, unknown, R>;
}

/** How many callers a "concurrent" case races. */
export const CONCURRENCY = 8;

/** Races `CONCURRENCY` copies of `effect` and returns every outcome, in completion-independent order. */
export const race = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.all(
    Array.from({ length: CONCURRENCY }, () => effect),
    { concurrency: "unbounded" },
  );

export interface RunConfig<R> {
  /** The adapter under test, e.g. "SessionStore (Ref)". */
  readonly adapter: string;
  /** Built afresh for every case. */
  readonly layer: Layer.Layer<R, unknown>;
  readonly cases: ReadonlyArray<Case<R>>;
}

/** Registers every case of `config` with the host test framework. */
export const run = <R>(framework: TestFramework, config: RunConfig<R>): void => {
  framework.describe(`StoreContract: ${config.adapter}`, () => {
    for (const contractCase of config.cases) {
      framework.it(contractCase.name, () =>
        Effect.runPromise(Effect.scoped(contractCase.run.pipe(Effect.provide(config.layer)))),
      );
    }
  });
};

// ---- auditLog -------------------------------------------------------------------------------

type AuditCase = Case<AuditLogStore.AuditLogStore>;

const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);

const auditRow = (
  id: string,
  options: {
    readonly eventTag?: string;
    readonly actor?: string;
    readonly minutes?: number;
    readonly payload?: string;
    readonly tenant?: string;
  } = {},
): AuditLogStore.AuditRow => ({
  id,
  eventTag: options.eventTag ?? "auth.test",
  actorUserId: Option.fromNullishOr(options.actor),
  occurredAt: at(options.minutes ?? 0),
  correlationId: Option.none(),
  tenantId: Option.fromNullishOr(options.tenant),
  payloadJson: options.payload ?? JSON.stringify({ id }),
});

const noFilter: AuditLogStore.AuditFilter = {
  eventTag: Option.none(),
  actorUserId: Option.none(),
  from: Option.none(),
  to: Option.none(),
};

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

/** The `AuditLogStore` contract (plan 02, ADR-EA-041; BEH-EA-100/102, ESA-005, ALF-010). */
export const auditLog: ReadonlyArray<AuditCase> = [
  {
    name: "append is idempotent on id: the second append of an id is false and changes nothing",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      assert.equal(yield* store.append(auditRow("a", { payload: '{"n":1}' })), true);
      assert.equal(yield* store.append(auditRow("a", { payload: '{"n":2}' })), false);
      const rows = yield* store.select(noFilter, "authoritative");
      assert.deepEqual(ids(rows), ["a"]);
      assert.equal(rows[0]?.payloadJson, '{"n":1}');
    }),
  },
  {
    name: "append is idempotent under concurrency: exactly one of 8 racing appends of one id is true",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      const results = yield* race(store.append(auditRow("same")));
      assert.equal(results.filter((stored) => stored).length, 1);
      assert.equal((yield* store.select(noFilter, "authoritative")).length, 1);
    }),
  },
  {
    name: "append stamps the ambient tenant, and an explicit tenant wins",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* Tenant.withTenant("tenant-a")(store.append(auditRow("ambient")));
      yield* Tenant.withTenant("tenant-a")(
        store.append(auditRow("explicit", { tenant: "tenant-b" })),
      );
      yield* Tenant.withoutTenant(store.append(auditRow("none")));
      const rows = yield* store.select(noFilter, "authoritative");
      const tenantOf = (id: string) => rows.find((row) => row.id === id)?.tenantId;
      assert.deepEqual(tenantOf("ambient"), Option.some("tenant-a"));
      assert.deepEqual(tenantOf("explicit"), Option.some("tenant-b"));
      assert.deepEqual(tenantOf("none"), Option.none());
    }),
  },
  {
    name: "append returns the payload byte for byte",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      const payload = JSON.stringify({
        text: 'a\u00e9 "quoted" 100% _x_ \\',
        nested: { list: [1, null, true] },
      });
      yield* store.append(auditRow("p", { payload }));
      const rows = yield* store.select(noFilter, "authoritative");
      assert.equal(rows[0]?.payloadJson, payload);
    }),
  },
  {
    name: "select is newest first, ties broken by id descending",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* store.append(auditRow("a", { minutes: 1 }));
      yield* store.append(auditRow("c", { minutes: 1 }));
      yield* store.append(auditRow("b", { minutes: 1 }));
      yield* store.append(auditRow("z", { minutes: 0 }));
      yield* store.append(auditRow("y", { minutes: 2 }));
      assert.deepEqual(ids(yield* store.select(noFilter, "authoritative")), [
        "y",
        "c",
        "b",
        "a",
        "z",
      ]);
    }),
  },
  {
    name: "select applies the filter in the store: bounds are inclusive, filters combine with AND, and a row outside it is never returned",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* store.append(auditRow("a", { eventTag: "one", actor: "u1", minutes: 0 }));
      yield* store.append(auditRow("b", { eventTag: "one", actor: "u2", minutes: 10 }));
      yield* store.append(auditRow("c", { eventTag: "two", actor: "u1", minutes: 20 }));
      // A row that no domain decoder could read: the filter must keep it out of a narrower listing.
      yield* store.append(auditRow("bad", { eventTag: "other", payload: "{", minutes: 5 }));
      const select = (filter: Partial<AuditLogStore.AuditFilter>) =>
        store.select({ ...noFilter, ...filter }, "authoritative").pipe(Effect.map(ids));
      assert.deepEqual(yield* select({ eventTag: Option.some("one") }), ["b", "a"]);
      assert.deepEqual(yield* select({ actorUserId: Option.some("u1") }), ["c", "a"]);
      assert.deepEqual(yield* select({ from: Option.some(at(10)), to: Option.some(at(20)) }), [
        "c",
        "b",
      ]);
      assert.deepEqual(
        yield* select({
          eventTag: Option.some("one"),
          actorUserId: Option.some("u1"),
          to: Option.some(at(0)),
        }),
        ["a"],
      );
      assert.deepEqual(yield* select({ eventTag: Option.some("nobody") }), []);
    }),
  },
  {
    name: "pageAfter pages in ascending byte order of id, strictly after the cursor, bounded by limit",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      // Ids that differ only in case and in the position of a hyphen: byte order, not a locale's.
      const all = ["B", "a", "a-b", "ab", "b", "~", "0"];
      for (const id of all) yield* store.append(auditRow(id));
      const expected = [...all].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      const pages: Array<string> = [];
      let after = Option.none<string>();
      for (let i = 0; i < 10; i++) {
        const page = yield* store.pageAfter(
          { after, eventTag: Option.none(), limit: 3 },
          "authoritative",
        );
        if (page.length === 0) break;
        pages.push(...ids(page));
        after = Option.some(page[page.length - 1]?.id ?? "");
      }
      assert.deepEqual(pages, expected);
    }),
  },
  {
    name: "pageAfter filters by tag before it limits",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* store.append(auditRow("1", { eventTag: "x" }));
      yield* store.append(auditRow("2", { eventTag: "y" }));
      yield* store.append(auditRow("3", { eventTag: "x" }));
      const page = yield* store.pageAfter(
        { after: Option.none(), eventTag: Option.some("x"), limit: 2 },
        "authoritative",
      );
      assert.deepEqual(ids(page), ["1", "3"]);
    }),
  },
  {
    name: "rewriteReferencing rewrites the rows that name the user as actor or anywhere in the payload, and reports how many",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* store.append(auditRow("actor", { actor: "user-1", payload: '{"x":1}' }));
      yield* store.append(auditRow("payload", { payload: '{"target":"user-1"}' }));
      yield* store.append(auditRow("both", { actor: "user-1", payload: '{"target":"user-1"}' }));
      yield* store.append(auditRow("other", { actor: "user-2", payload: '{"target":"user-2"}' }));
      const count = yield* store.rewriteReferencing("user-1", (row) =>
        Option.some({
          actorUserId: Option.map(row.actorUserId, () => "erased-1"),
          payloadJson: row.payloadJson.replaceAll("user-1", "erased-1"),
        }),
      );
      assert.equal(count, 3);
      const rows = yield* store.select(noFilter, "authoritative");
      assert.equal(
        rows.some((row) => row.payloadJson.includes("user-1")),
        false,
      );
      assert.equal(rows.find((row) => row.id === "other")?.payloadJson, '{"target":"user-2"}');
      assert.deepEqual(
        rows.find((row) => row.id === "actor")?.actorUserId,
        Option.some("erased-1"),
      );
      // Idempotent: nothing names the user any more.
      assert.equal(
        yield* store.rewriteReferencing("user-1", () =>
          Option.some({ actorUserId: Option.none(), payloadJson: "{}" }),
        ),
        0,
      );
    }),
  },
  {
    name: "rewriteReferencing treats the user id as a literal, never a pattern",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* store.append(auditRow("a", { payload: '{"id":"a_c"}' }));
      yield* store.append(auditRow("b", { payload: '{"id":"abc"}' }));
      const count = yield* store.rewriteReferencing("a_c", () =>
        Option.some({ actorUserId: Option.none(), payloadJson: "{}" }),
      );
      assert.equal(count, 1);
    }),
  },
  {
    name: "rewriteReferencing is all-or-nothing: a rewrite that dies on the third row changes none",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      for (const id of ["1", "2", "3", "4"]) yield* store.append(auditRow(id, { actor: "user-1" }));
      let seen = 0;
      const exit = yield* Effect.exit(
        store.rewriteReferencing("user-1", () => {
          seen += 1;
          if (seen === 3) throw new Error("the scrub died on the third row");
          return Option.some({ actorUserId: Option.some("erased"), payloadJson: "{}" });
        }),
      );
      assert.equal(exit._tag, "Failure");
      const rows = yield* store.select(noFilter, "authoritative");
      assert.deepEqual(
        rows.map((row) => row.actorUserId),
        Array.from({ length: 4 }, () => Option.some("user-1")),
      );
      assert.equal(
        rows.every((row) => row.payloadJson !== "{}"),
        true,
      );
    }),
  },
  {
    name: "deleteBefore removes only rows strictly older than the cutoff, for the given tags, never an excepted one",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* store.append(auditRow("a", { eventTag: "one", minutes: 0 }));
      yield* store.append(auditRow("b", { eventTag: "two", minutes: 0 }));
      yield* store.append(auditRow("c", { eventTag: "one", minutes: 60 }));
      yield* store.append(auditRow("d", { eventTag: "three", minutes: 0 }));
      yield* store.append(auditRow("e", { eventTag: "one", minutes: 30 }));
      const remaining = store
        .select(noFilter, "authoritative")
        .pipe(Effect.map((rows) => ids(rows).sort()));
      // Only the listed tag, only before the cutoff (a row AT the cutoff survives).
      assert.equal(
        yield* store.deleteBefore({
          cutoff: at(30),
          eventTags: Option.some(["one"]),
          exceptTags: [],
        }),
        1,
      );
      assert.deepEqual(yield* remaining, ["b", "c", "d", "e"]);
      // Every tag but `three`.
      assert.equal(
        yield* store.deleteBefore({
          cutoff: at(30),
          eventTags: Option.none(),
          exceptTags: ["three"],
        }),
        1,
      );
      assert.deepEqual(yield* remaining, ["c", "d", "e"]);
      // No tag filter, no exception.
      assert.equal(
        yield* store.deleteBefore({ cutoff: at(120), eventTags: Option.none(), exceptTags: [] }),
        3,
      );
      assert.deepEqual(yield* remaining, []);
    }),
  },
  {
    name: "deleteBefore drains a backlog larger than one batch",
    run: Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* Effect.forEach(
        Array.from({ length: 1100 }, (_, index) => `id-${String(index).padStart(5, "0")}`),
        (id) => store.append(auditRow(id)),
        { concurrency: 1 },
      );
      assert.equal(
        yield* store.deleteBefore({ cutoff: at(1), eventTags: Option.none(), exceptTags: [] }),
        1100,
      );
      assert.deepEqual(yield* store.select(noFilter, "authoritative"), []);
    }),
  },
];

// ---- verification ---------------------------------------------------------------------------

type VerificationCase = Case<VerificationStore.VerificationStore>;

const makeTokenId = Schema.decodeUnknownSync(Ids.VerificationTokenId);
const makeUserId = Schema.decodeUnknownSync(Ids.UserId);

const newToken = (
  id: string,
  identifier: string,
  valueHash: string,
  options: {
    readonly minutes?: number;
    readonly ttlMinutes?: number;
    readonly userId?: string;
    readonly maxAttempts?: number;
    readonly payload?: string;
  } = {},
): VerificationStore.NewToken => ({
  id: makeTokenId(id),
  identifier,
  userId: Option.map(Option.fromNullishOr(options.userId), makeUserId),
  valueHash,
  createdAt: at(options.minutes ?? 0),
  expiresAt: at((options.minutes ?? 0) + (options.ttlMinutes ?? 10)),
  payloadJson: Option.fromNullishOr(options.payload),
  maxAttempts: Option.fromNullishOr(options.maxAttempts),
});

const present = (
  identifier: string,
  valueHash: string,
  minutes = 1,
  hold = false,
): Effect.Effect<VerificationStore.PresentOutcome, unknown, VerificationStore.VerificationStore> =>
  Effect.flatMap(VerificationStore.VerificationStore, (store) =>
    store.present({ identifier, valueHash, now: at(minutes), hold }),
  );

const hits = (outcomes: ReadonlyArray<VerificationStore.PresentOutcome>) =>
  outcomes.filter((outcome) => outcome._tag === "Hit").length;

/** The `VerificationStore` contract (plan 02, ADR-EA-041; BEH-EA-057 to 063, ADR-EA-016, SOS-004). */
export const verification: ReadonlyArray<VerificationCase> = [
  {
    name: "upsertLive stores the row with no attempts spent, nothing consumed, and the ambient tenant",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      const row = yield* Tenant.withTenant("tenant-a")(
        store.upsertLive(newToken("t1", "verify-email:u1", "h1", { userId: "u1", maxAttempts: 3 })),
      );
      assert.equal(row.attempts, 0);
      assert.deepEqual(row.consumedAt, Option.none());
      assert.deepEqual(row.tenantId, Option.some("tenant-a"));
      assert.deepEqual(row.maxAttempts, Option.some(3));
      assert.deepEqual(row.userId, Option.some("u1"));
    }),
  },
  {
    name: "upsertLive replaces the identifier's live row: the old value stops working, the new one works",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "reset-password:u1", "old"));
      yield* store.upsertLive(newToken("t2", "reset-password:u1", "new"));
      assert.equal((yield* present("reset-password:u1", "old"))._tag, "Miss");
      assert.equal((yield* present("reset-password:u1", "new"))._tag, "Hit");
    }),
  },
  {
    name: "upsertLive under concurrency leaves exactly one live row: exactly one of 8 racing values works",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* Effect.all(
        Array.from({ length: CONCURRENCY }, (_, index) =>
          store.upsertLive(newToken(`t${index}`, "verify-email:race", `hash-${index}`)),
        ),
        { concurrency: "unbounded" },
      );
      const outcomes = yield* Effect.all(
        Array.from({ length: CONCURRENCY }, (_, index) =>
          present("verify-email:race", `hash-${index}`),
        ),
      );
      assert.equal(hits(outcomes), 1);
    }),
  },
  {
    name: "upsertLive keeps the consumed history of the identifier",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "verify-email:u1", "h1", { userId: "u1" }));
      assert.equal((yield* present("verify-email:u1", "h1"))._tag, "Hit");
      yield* store.upsertLive(newToken("t2", "verify-email:u1", "h2", { userId: "u1" }));
      // Both the consumed row and the new live one name the user.
      assert.equal(yield* store.deleteByUser(makeUserId("u1")), 2);
    }),
  },
  {
    name: "present is a Hit exactly once, returns the consumed row with its payload, and a replay is a Miss",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      const payload = JSON.stringify({ codeVerifier: "v", note: 'aé "quoted" 100% _x_' });
      yield* store.upsertLive(newToken("t1", "oauth.flow:1", "h1", { payload }));
      const first = yield* present("oauth.flow:1", "h1", 2);
      assert.equal(first._tag, "Hit");
      if (first._tag === "Hit") {
        assert.equal(first.row.id, "t1");
        assert.deepEqual(first.row.consumedAt, Option.some(at(2)));
        assert.deepEqual(first.row.payloadJson, Option.some(payload));
      }
      assert.equal((yield* present("oauth.flow:1", "h1", 3))._tag, "Miss");
    }),
  },
  {
    name: "present never matches an unknown identifier or a wrong value, and a wrong value costs an unbudgeted token nothing",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "verify-email:u1", "h1"));
      assert.equal((yield* present("verify-email:nobody", "h1"))._tag, "Miss");
      for (let i = 0; i < 10; i++)
        assert.equal((yield* present("verify-email:u1", "wrong"))._tag, "Miss");
      assert.equal((yield* present("verify-email:u1", "h1"))._tag, "Hit");
    }),
  },
  {
    name: "present refuses an expired token: a Hit one tick before expiresAt, a Miss at exactly expiresAt",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "a", "h", { ttlMinutes: 10 }));
      yield* store.upsertLive(newToken("t2", "b", "h", { ttlMinutes: 10 }));
      const justBefore = DateTime.makeUnsafe(at(10).epochMilliseconds - 1);
      const early = yield* store.present({
        identifier: "a",
        valueHash: "h",
        now: justBefore,
        hold: false,
      });
      assert.equal(early._tag, "Hit");
      assert.equal((yield* present("b", "h", 10))._tag, "Miss");
    }),
  },
  {
    name: "present under concurrency: exactly one of 8 presentations of the right value is a Hit (BEH-EA-062)",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "reset-password:u1", "h1"));
      const outcomes = yield* race(present("reset-password:u1", "h1"));
      assert.equal(hits(outcomes), 1);
    }),
  },
  {
    name: "a wrong value spends an attempt of a budgeted token, which is burned at maxAttempts (SOS-004)",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "email-otp:u1", "right", { maxAttempts: 3 }));
      for (let i = 0; i < 3; i++)
        assert.equal((yield* present("email-otp:u1", "wrong"))._tag, "Miss");
      assert.equal((yield* present("email-otp:u1", "right"))._tag, "Miss");
    }),
  },
  {
    name: "fewer wrong values than the budget leave a budgeted token usable",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "email-otp:u1", "right", { maxAttempts: 3 }));
      for (let i = 0; i < 2; i++)
        assert.equal((yield* present("email-otp:u1", "wrong"))._tag, "Miss");
      assert.equal((yield* present("email-otp:u1", "right"))._tag, "Hit");
    }),
  },
  {
    name: "concurrent wrong values cannot overshoot the budget: 8 guesses against a budget of 3 burn the token",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "email-otp:u1", "right", { maxAttempts: 3 }));
      yield* race(present("email-otp:u1", "wrong"));
      assert.equal((yield* present("email-otp:u1", "right"))._tag, "Miss");
    }),
  },
  {
    name: "a hold that is settled as kept leaves the token spent",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "reset-password:u1", "h1"));
      const claimed = yield* present("reset-password:u1", "h1", 1, true);
      assert.equal(claimed._tag, "Hit");
      yield* store.settle(makeTokenId("t1"), "kept");
      assert.equal((yield* present("reset-password:u1", "h1", 2))._tag, "Miss");
    }),
  },
  {
    name: "transaction runs its body once, returns its result, and passes its own failure through untouched",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      let runs = 0;
      const value = yield* store.transaction(
        Effect.sync(() => {
          runs += 1;
          return "result";
        }),
      );
      assert.equal(value, "result");
      assert.equal(runs, 1);
      const refusal = { refused: "the caller's own work" };
      const failure = yield* store.transaction(Effect.fail(refusal)).pipe(Effect.flip);
      assert.equal(failure, refusal);
    }),
  },
  {
    name: "reserve is exclusive while live and free at exactly expiresAt; a zero ttl is free at once",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      const reserve = (identifier: string, minutes: number, ttlMinutes: number) =>
        store.reserve({
          identifier,
          now: at(minutes),
          expiresAt: at(minutes + ttlMinutes),
        });
      assert.equal(yield* reserve("promote:u1", 0, 5), true);
      assert.equal(yield* reserve("promote:u1", 4, 5), false);
      assert.equal(yield* reserve("promote:u1", 5, 5), true);
      assert.equal(yield* reserve("zero", 0, 0), true);
      assert.equal(yield* reserve("zero", 0, 0), true);
    }),
  },
  {
    name: "reserve under concurrency: exactly one of 8 claims of one identifier is true (BEH-EA-063)",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      const results = yield* race(
        store.reserve({ identifier: "promote:race", now: at(0), expiresAt: at(5) }),
      );
      assert.equal(results.filter((granted) => granted).length, 1);
    }),
  },
  {
    name: "deleteByUser sweeps the user's tokens, consumed ones included, and nobody else's",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "verify-email:u1", "h1", { userId: "u1" }));
      yield* store.upsertLive(newToken("t2", "reset-password:u1", "h2", { userId: "u1" }));
      yield* store.upsertLive(newToken("t3", "verify-email:u2", "h3", { userId: "u2" }));
      assert.equal((yield* present("verify-email:u1", "h1"))._tag, "Hit");
      assert.equal(yield* store.deleteByUser(makeUserId("u1")), 2);
      assert.equal((yield* present("reset-password:u1", "h2"))._tag, "Miss");
      assert.equal((yield* present("verify-email:u2", "h3"))._tag, "Hit");
    }),
  },
  {
    name: "purgeExpired removes consumed tokens, expired tokens and expired reservations, and keeps a live token",
    run: Effect.gen(function* () {
      const store = yield* VerificationStore.VerificationStore;
      yield* store.upsertLive(newToken("t1", "consumed", "h1", { ttlMinutes: 600 }));
      yield* store.upsertLive(newToken("t2", "expired", "h2", { ttlMinutes: 5 }));
      yield* store.upsertLive(newToken("t3", "live", "h3", { ttlMinutes: 600 }));
      assert.equal((yield* present("consumed", "h1", 1))._tag, "Hit");
      yield* store.reserve({ identifier: "r-old", now: at(0), expiresAt: at(5) });
      yield* store.reserve({ identifier: "r-live", now: at(0), expiresAt: at(600) });
      // The consumed row, the expired token and the expired reservation go; nothing else.
      assert.equal(yield* store.purgeExpired(at(30)), 3);
      assert.equal((yield* present("live", "h3", 31))._tag, "Hit");
      assert.equal(
        yield* store.reserve({ identifier: "r-live", now: at(31), expiresAt: at(40) }),
        false,
      );
      assert.equal(yield* store.purgeExpired(at(30)), 0);
    }),
  },
];

// ---- accounts -------------------------------------------------------------------------------

type AccountCase = Case<AccountStore.AccountStore>;

const makeAccountId = Schema.decodeUnknownSync(Ids.AccountId);

const newAccount = (
  id: string,
  userId: string,
  options: {
    readonly providerId?: string;
    readonly subject?: string;
    readonly issuer?: string;
    readonly minutes?: number;
    readonly credentialHash?: string;
    readonly tokens?: AccountStore.ProviderTokens;
  } = {},
): AccountStore.NewAccount => ({
  id: makeAccountId(id),
  userId: makeUserId(userId),
  providerId: options.providerId ?? "github",
  subject: options.subject ?? `subject-${id}`,
  issuer: options.issuer ?? "",
  credentialHash: Option.map(Option.fromNullishOr(options.credentialHash), Redacted.make),
  tokens: Option.fromNullishOr(options.tokens),
  createdAt: at(options.minutes ?? 0),
  updatedAt: at(options.minutes ?? 0),
});

const sampleTokens: AccountStore.ProviderTokens = {
  accessToken: Redacted.make("access-1"),
  refreshToken: Option.some(Redacted.make("refresh-1")),
  idToken: Option.some(Redacted.make("id-1")),
  accessTokenExpiresAt: Option.some(at(60)),
  refreshTokenExpiresAt: Option.some(at(600)),
  scope: Option.some("openid email"),
  tokenType: Option.some("Bearer"),
};

const accountIds = (rows: ReadonlyArray<AccountStore.AccountIdentity>) => rows.map((row) => row.id);

/** The `AccountStore` contract (plan 02, ADR-EA-041; BEH-EA-043 to 045, BEH-EA-125, BE-002, SMS-002). */
export const accounts: ReadonlyArray<AccountCase> = [
  {
    name: "insertIfAbsent stores the identity and stamps the ambient tenant",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      const stored = yield* Tenant.withTenant("tenant-a")(
        store.insertIfAbsent(
          newAccount("a1", "u1", { providerId: "google", subject: "sub-1", issuer: "https://iss" }),
        ),
      );
      assert.equal(Option.isSome(stored), true);
      const identity = Option.getOrThrow(stored);
      assert.equal(identity.id, "a1");
      assert.equal(identity.providerId, "google");
      assert.equal(identity.issuer, "https://iss");
      assert.deepEqual(identity.tenantId, Option.some("tenant-a"));
      assert.deepEqual(identity.createdAt, at(0));
    }),
  },
  {
    name: "insertIfAbsent is exclusive per (providerId, subject, issuer); a different issuer is a different account",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      const base = { providerId: "google", subject: "sub-1" };
      assert.equal(Option.isSome(yield* store.insertIfAbsent(newAccount("a1", "u1", base))), true);
      // Taken: same key, whoever the user.
      assert.equal(Option.isNone(yield* store.insertIfAbsent(newAccount("a2", "u2", base))), true);
      // Another issuer, another provider, another subject: all free.
      assert.equal(
        Option.isSome(
          yield* store.insertIfAbsent(newAccount("a3", "u1", { ...base, issuer: "https://other" })),
        ),
        true,
      );
      assert.equal(
        Option.isSome(
          yield* store.insertIfAbsent(newAccount("a4", "u1", { ...base, providerId: "github" })),
        ),
        true,
      );
      assert.equal(
        Option.isSome(
          yield* store.insertIfAbsent(newAccount("a5", "u1", { ...base, subject: "sub-2" })),
        ),
        true,
      );
      // The failed insert left nothing behind: the first row is still the holder.
      const holder = yield* store.getByKey("google", "sub-1", "");
      assert.equal(Option.getOrThrow(holder).id, "a1");
    }),
  },
  {
    name: "insertIfAbsent under concurrency: exactly one of 8 racing inserts of one key is Some",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      const results = yield* Effect.all(
        Array.from({ length: CONCURRENCY }, (_, index) =>
          store.insertIfAbsent(
            newAccount(`race-${index}`, "u1", { providerId: "google", subject: "same" }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Option.isSome).length, 1);
    }),
  },
  {
    name: "get, getByKey and listByUser read the identity; listByUser is the user's own, ordered by (createdAt, id)",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      yield* store.insertIfAbsent(newAccount("b", "u1", { minutes: 5 }));
      yield* store.insertIfAbsent(newAccount("c", "u1", { minutes: 5 }));
      yield* store.insertIfAbsent(newAccount("a", "u1", { minutes: 9 }));
      yield* store.insertIfAbsent(newAccount("z", "u2", { minutes: 0 }));
      assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("u1"))), ["b", "c", "a"]);
      assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("nobody"))), []);
      assert.equal(Option.getOrThrow(yield* store.get(makeAccountId("a"))).userId, "u1");
      assert.equal(Option.isNone(yield* store.get(makeAccountId("missing"))), true);
      assert.equal(Option.getOrThrow(yield* store.getByKey("github", "subject-z", "")).id, "z");
      assert.equal(
        Option.isNone(yield* store.getByKey("github", "subject-z", "https://iss")),
        true,
      );
    }),
  },
  {
    name: "readCredentialHash distinguishes no account, an account with no hash, and the hash",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      yield* store.insertIfAbsent(newAccount("with", "u1", { credentialHash: "$argon2id$stored" }));
      yield* store.insertIfAbsent(newAccount("without", "u1"));
      assert.equal(Option.isNone(yield* store.readCredentialHash(makeAccountId("missing"))), true);
      const none = Option.getOrThrow(yield* store.readCredentialHash(makeAccountId("without")));
      assert.equal(Option.isNone(none), true);
      const some = Option.getOrThrow(yield* store.readCredentialHash(makeAccountId("with")));
      assert.equal(Redacted.value(Option.getOrThrow(some)), "$argon2id$stored");
    }),
  },
  {
    name: "readProviderTokens round-trips every field, is empty for an account with none, and is None for no account",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      yield* store.insertIfAbsent(newAccount("with", "u1", { tokens: sampleTokens }));
      yield* store.insertIfAbsent(newAccount("without", "u1"));
      assert.equal(Option.isNone(yield* store.readProviderTokens(makeAccountId("missing"))), true);
      const empty = Option.getOrThrow(yield* store.readProviderTokens(makeAccountId("without")));
      assert.deepEqual(empty, { _tag: "Tokens", tokens: Option.none() });
      const read = Option.getOrThrow(yield* store.readProviderTokens(makeAccountId("with")));
      assert.equal(read._tag, "Tokens");
      if (read._tag === "Tokens") {
        const tokens = Option.getOrThrow(read.tokens);
        assert.equal(Redacted.value(tokens.accessToken), "access-1");
        assert.equal(Redacted.value(Option.getOrThrow(tokens.refreshToken)), "refresh-1");
        assert.equal(Redacted.value(Option.getOrThrow(tokens.idToken)), "id-1");
        assert.deepEqual(tokens.accessTokenExpiresAt, Option.some(at(60)));
        assert.deepEqual(tokens.refreshTokenExpiresAt, Option.some(at(600)));
        assert.deepEqual(tokens.scope, Option.some("openid email"));
        assert.deepEqual(tokens.tokenType, Option.some("Bearer"));
      }
    }),
  },
  {
    name: "writeCredentialHash and writeProviderTokens replace the value, bump updatedAt and leave the identity alone; an absent account is false",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      yield* store.insertIfAbsent(
        newAccount("a", "u1", { credentialHash: "old", tokens: sampleTokens }),
      );
      assert.equal(
        yield* store.writeCredentialHash(makeAccountId("a"), Redacted.make("new"), at(10)),
        true,
      );
      const hash = Option.getOrThrow(
        Option.getOrThrow(yield* store.readCredentialHash(makeAccountId("a"))),
      );
      assert.equal(Redacted.value(hash), "new");
      assert.deepEqual(Option.getOrThrow(yield* store.get(makeAccountId("a"))).updatedAt, at(10));
      assert.equal(
        yield* store.writeProviderTokens(
          makeAccountId("a"),
          { ...sampleTokens, accessToken: Redacted.make("rotated"), refreshToken: Option.none() },
          at(20),
        ),
        true,
      );
      const read = Option.getOrThrow(yield* store.readProviderTokens(makeAccountId("a")));
      if (read._tag === "Tokens") {
        const tokens = Option.getOrThrow(read.tokens);
        assert.equal(Redacted.value(tokens.accessToken), "rotated");
        assert.equal(Option.isNone(tokens.refreshToken), true);
      }
      const identity = Option.getOrThrow(yield* store.get(makeAccountId("a")));
      assert.deepEqual(identity.updatedAt, at(20));
      assert.deepEqual(identity.createdAt, at(0));
      assert.equal(
        yield* store.writeCredentialHash(makeAccountId("missing"), Redacted.make("x"), at(1)),
        false,
      );
      assert.equal(
        yield* store.writeProviderTokens(makeAccountId("missing"), sampleTokens, at(1)),
        false,
      );
    }),
  },
  {
    name: "deleteUnlessLast deletes a sibling, refuses the last account unless allowed, and says NotFound for none",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      yield* store.insertIfAbsent(newAccount("a", "u1"));
      yield* store.insertIfAbsent(newAccount("b", "u1"));
      assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("a"), false), {
        _tag: "Deleted",
      });
      assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("b"), false), {
        _tag: "LastAccount",
        userId: "u1",
      });
      assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("u1"))), ["b"]);
      assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("b"), true), {
        _tag: "Deleted",
      });
      assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("b"), true), {
        _tag: "NotFound",
      });
      // A deleted account frees its key.
      assert.equal(
        Option.isSome(yield* store.insertIfAbsent(newAccount("c", "u2", { subject: "subject-a" }))),
        true,
      );
    }),
  },
  {
    name: "deleteUnlessLast under concurrency: unlinking a user's two accounts together never leaves none (BEH-EA-045)",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      const users = Array.from({ length: CONCURRENCY }, (_, index) => `racer-${index}`);
      for (const user of users) {
        yield* store.insertIfAbsent(newAccount(`${user}-a`, user));
        yield* store.insertIfAbsent(newAccount(`${user}-b`, user));
      }
      yield* Effect.all(
        users.flatMap((user) => [
          store.deleteUnlessLast(makeAccountId(`${user}-a`), false),
          store.deleteUnlessLast(makeAccountId(`${user}-b`), false),
        ]),
        { concurrency: "unbounded" },
      );
      for (const user of users) {
        assert.equal((yield* store.listByUser(makeUserId(user))).length, 1, user);
      }
    }),
  },
  {
    name: "deleteByUser removes every account of the user, regardless of the last-account rule, and nobody else's",
    run: Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      yield* store.insertIfAbsent(newAccount("a", "u1"));
      yield* store.insertIfAbsent(newAccount("b", "u1"));
      yield* store.insertIfAbsent(newAccount("c", "u2"));
      assert.equal(yield* store.deleteByUser(makeUserId("u1")), 2);
      assert.equal(yield* store.deleteByUser(makeUserId("u1")), 0);
      assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("u2"))), ["c"]);
    }),
  },
];

// ---- users ----------------------------------------------------------------------------------

/**
 * The declared-field columns (ADR-EA-035) the `users` cases write. A runner whose store keeps them as
 * columns of the user row (SQL) must add exactly these to `users` before it runs the cases.
 */
const textColumn: UserStore.UserFieldColumn = { name: "contract_text", kind: "text" };
const realColumn: UserStore.UserFieldColumn = { name: "contract_real", kind: "real" };
const flagColumn: UserStore.UserFieldColumn = { name: "contract_flag", kind: "boolean" };
export const userFieldColumns: ReadonlyArray<UserStore.UserFieldColumn> = [
  textColumn,
  realColumn,
  flagColumn,
];

/** The cases that open a transaction need the port that provides it (`layerNoop` beside a `Ref` store). */
type UserCase = Case<UserStore.UserStore | SqlTransaction.SqlTransaction>;

const makeE164 = Schema.decodeUnknownSync(Ids.E164);

const newUser = (
  id: string,
  options: {
    readonly email?: string;
    readonly phone?: string;
    readonly name?: string;
    readonly minutes?: number;
  } = {},
): UserStore.NewUser => ({
  id: makeUserId(id),
  email: Option.fromNullishOr(options.email),
  emailVerified: false,
  phone: Option.map(Option.fromNullishOr(options.phone), makeE164),
  phoneVerified: false,
  name: options.name ?? `name-${id}`,
  image: Option.none(),
  metadata: Option.none(),
  status: "active",
  statusReason: Option.none(),
  suspendedUntil: Option.none(),
  createdAt: at(options.minutes ?? 0),
  updatedAt: at(options.minutes ?? 0),
});

const userIds = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

const inserted = (outcome: UserStore.InsertOutcome) => outcome._tag === "Inserted";

/** The `UserStore` contract (plan 02, ADR-EA-041; BEH-EA-041, BEH-EA-042, GC-004, SAM-004, AAPS-005). */
export const users: ReadonlyArray<UserCase> = [
  {
    name: "insertOrHolder stores the user and stamps the ambient tenant",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const outcome = yield* Tenant.withTenant("tenant-a")(
        store.insertOrHolder(newUser("u1", { email: "a@example.com" })),
      );
      assert.equal(outcome._tag, "Inserted");
      if (outcome._tag === "Inserted") {
        assert.deepEqual(outcome.user.tenantId, Option.some("tenant-a"));
        assert.deepEqual(outcome.user.email, Option.some("a@example.com"));
        assert.equal(outcome.user.status, "active");
      }
      const reread = Option.getOrThrow(yield* store.get(makeUserId("u1")));
      assert.deepEqual(reread.tenantId, Option.some("tenant-a"));
      assert.deepEqual(reread.createdAt, at(0));
    }),
  },
  {
    name: "insertOrHolder answers Held with the holder of an existing email or phone, and never for an anonymous user",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      assert.equal(
        inserted(yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }))),
        true,
      );
      assert.equal(
        inserted(yield* store.insertOrHolder(newUser("u2", { phone: "+14155550100" }))),
        true,
      );
      const emailHeld = yield* store.insertOrHolder(newUser("u3", { email: "a@example.com" }));
      assert.equal(emailHeld._tag, "Held");
      if (emailHeld._tag === "Held") assert.equal(emailHeld.holder.id, "u1");
      const phoneHeld = yield* store.insertOrHolder(newUser("u4", { phone: "+14155550100" }));
      assert.equal(phoneHeld._tag, "Held");
      if (phoneHeld._tag === "Held") assert.equal(phoneHeld.holder.id, "u2");
      // The refused insert left nothing behind.
      assert.equal(Option.isNone(yield* store.get(makeUserId("u3"))), true);
      // Anonymous users never conflict.
      assert.equal(inserted(yield* store.insertOrHolder(newUser("g1"))), true);
      assert.equal(inserted(yield* store.insertOrHolder(newUser("g2"))), true);
    }),
  },
  {
    name: "insertOrHolder under concurrency: exactly one of 8 racing inserts of one email is Inserted",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const outcomes = yield* Effect.all(
        Array.from({ length: CONCURRENCY }, (_, index) =>
          store.insertOrHolder(newUser(`race-${index}`, { email: "race@example.com" })),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter(inserted).length, 1);
      const holders = new Set(
        outcomes.flatMap((outcome) => (outcome._tag === "Held" ? [outcome.holder.id] : [])),
      );
      assert.equal(holders.size, 1);
    }),
  },
  {
    name: "insertOrHolder that finds a holder leaves an enclosing transaction usable (U-7)",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      const transaction = yield* SqlTransaction.SqlTransaction;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      yield* transaction.withTransaction(
        Effect.gen(function* () {
          const held = yield* store.insertOrHolder(newUser("u2", { email: "a@example.com" }));
          assert.equal(held._tag, "Held");
          // A statement after the refused insert still runs: the transaction was not aborted.
          assert.equal(
            inserted(yield* store.insertOrHolder(newUser("u3", { email: "b@example.com" }))),
            true,
          );
        }),
      );
      assert.equal(Option.isSome(yield* store.get(makeUserId("u3"))), true);
    }),
  },
  {
    name: "getByEmail and getByPhone find the holder by the stored key and nobody else",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      yield* store.insertOrHolder(newUser("u2", { phone: "+14155550100" }));
      assert.equal(Option.getOrThrow(yield* store.getByEmail("a@example.com")).id, "u1");
      assert.equal(Option.isNone(yield* store.getByEmail("other@example.com")), true);
      assert.equal(Option.getOrThrow(yield* store.getByPhone(makeE164("+14155550100"))).id, "u2");
      assert.equal(Option.isNone(yield* store.getByPhone(makeE164("+14155550199"))), true);
    }),
  },
  {
    name: "casIdentity applies once, reports Stale with the current user when the columns moved, Taken on a collision, Missing for no user",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      yield* store.insertOrHolder(newUser("u2", { email: "b@example.com" }));
      const before = UserStore.identityOf(Option.getOrThrow(yield* store.get(makeUserId("u1"))));
      const verified = { ...before, emailVerified: true };
      const first = yield* store.casIdentity({
        id: makeUserId("u1"),
        expected: before,
        next: verified,
        at: at(5),
      });
      assert.equal(first._tag, "Updated");
      if (first._tag === "Updated") {
        assert.equal(first.user.emailVerified, true);
        assert.deepEqual(first.user.updatedAt, at(5));
      }
      // The same swap again: the columns are no longer what the caller read.
      const stale = yield* store.casIdentity({
        id: makeUserId("u1"),
        expected: before,
        next: verified,
        at: at(6),
      });
      assert.equal(stale._tag, "Stale");
      if (stale._tag === "Stale") assert.equal(stale.current.emailVerified, true);
      // A new email held by another user.
      const collision = yield* store.casIdentity({
        id: makeUserId("u1"),
        expected: verified,
        next: { ...verified, email: Option.some("b@example.com"), emailVerified: false },
        at: at(7),
      });
      assert.equal(collision._tag, "Taken");
      assert.equal(
        Option.getOrThrow(yield* store.get(makeUserId("u1"))).email.pipe(Option.getOrThrow),
        "a@example.com",
      );
      const missing = yield* store.casIdentity({
        id: makeUserId("nobody"),
        expected: before,
        next: verified,
        at: at(8),
      });
      assert.equal(missing._tag, "Missing");
    }),
  },
  {
    name: "casIdentity moves an anonymous user to an email, and frees the old key when an address changes",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("anon"));
      yield* store.insertOrHolder(newUser("u1", { email: "old@example.com" }));
      const anon = UserStore.identityOf(Option.getOrThrow(yield* store.get(makeUserId("anon"))));
      const promoted = yield* store.casIdentity({
        id: makeUserId("anon"),
        expected: anon,
        next: { ...anon, email: Option.some("new@example.com") },
        at: at(1),
      });
      assert.equal(promoted._tag, "Updated");
      assert.equal(Option.getOrThrow(yield* store.getByEmail("new@example.com")).id, "anon");
      const u1 = UserStore.identityOf(Option.getOrThrow(yield* store.get(makeUserId("u1"))));
      yield* store.casIdentity({
        id: makeUserId("u1"),
        expected: u1,
        next: { ...u1, email: Option.some("moved@example.com") },
        at: at(2),
      });
      assert.equal(Option.isNone(yield* store.getByEmail("old@example.com")), true);
      assert.equal(
        inserted(yield* store.insertOrHolder(newUser("u9", { email: "old@example.com" }))),
        true,
      );
    }),
  },
  {
    name: "casIdentity under concurrency: exactly one of 8 identical verifications is Updated",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      const before = UserStore.identityOf(Option.getOrThrow(yield* store.get(makeUserId("u1"))));
      const outcomes = yield* race(
        store.casIdentity({
          id: makeUserId("u1"),
          expected: before,
          next: { ...before, emailVerified: true },
          at: at(1),
        }),
      );
      assert.equal(outcomes.filter((outcome) => outcome._tag === "Updated").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome._tag === "Stale").length, CONCURRENCY - 1);
    }),
  },
  {
    name: "updateProfile writes name, sets/clears/keeps image and metadata, bumps updatedAt, and is None for no user",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      const set = yield* store.updateProfile({
        id: makeUserId("u1"),
        name: "Renamed",
        image: { _tag: "Set", value: "https://img" },
        metadata: { _tag: "Set", value: "{}" },
        at: at(3),
      });
      const afterSet = Option.getOrThrow(set);
      assert.equal(afterSet.name, "Renamed");
      assert.deepEqual(afterSet.image, Option.some("https://img"));
      assert.deepEqual(afterSet.metadata, Option.some("{}"));
      assert.deepEqual(afterSet.updatedAt, at(3));
      assert.deepEqual(afterSet.email, Option.some("a@example.com"));
      const kept = Option.getOrThrow(
        yield* store.updateProfile({
          id: makeUserId("u1"),
          name: "Again",
          image: { _tag: "Keep" },
          metadata: { _tag: "Keep" },
          at: at(4),
        }),
      );
      assert.deepEqual(kept.image, Option.some("https://img"));
      assert.deepEqual(kept.metadata, Option.some("{}"));
      const cleared = Option.getOrThrow(
        yield* store.updateProfile({
          id: makeUserId("u1"),
          name: "Again",
          image: { _tag: "Clear" },
          metadata: { _tag: "Clear" },
          at: at(5),
        }),
      );
      assert.deepEqual(cleared.image, Option.none());
      assert.deepEqual(cleared.metadata, Option.none());
      assert.equal(
        Option.isNone(
          yield* store.updateProfile({
            id: makeUserId("nobody"),
            name: "x",
            image: { _tag: "Keep" },
            metadata: { _tag: "Keep" },
            at: at(6),
          }),
        ),
        true,
      );
    }),
  },
  {
    name: "setStatus writes the status, its reason and expiry, bumps updatedAt, and is None for no user",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      const suspended = Option.getOrThrow(
        yield* store.setStatus({
          id: makeUserId("u1"),
          status: "suspended",
          reason: Option.some("spam"),
          until: Option.some(at(100)),
          at: at(2),
        }),
      );
      assert.equal(suspended.status, "suspended");
      assert.deepEqual(suspended.statusReason, Option.some("spam"));
      assert.deepEqual(suspended.suspendedUntil, Option.some(at(100)));
      assert.deepEqual(suspended.updatedAt, at(2));
      const active = Option.getOrThrow(
        yield* store.setStatus({
          id: makeUserId("u1"),
          status: "active",
          reason: Option.none(),
          until: Option.none(),
          at: at(3),
        }),
      );
      assert.equal(active.status, "active");
      assert.deepEqual(active.statusReason, Option.none());
      assert.deepEqual(active.suspendedUntil, Option.none());
      assert.equal(
        Option.isNone(
          yield* store.setStatus({
            id: makeUserId("nobody"),
            status: "active",
            reason: Option.none(),
            until: Option.none(),
            at: at(4),
          }),
        ),
        true,
      );
    }),
  },
  {
    name: "writeFields returns its own post-state, null clears a field, every kind round-trips, and updatedAt moves",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      assert.deepEqual(
        Option.getOrThrow(yield* store.readFields(makeUserId("u1"), userFieldColumns)),
        {},
      );
      const written = yield* store.writeFields({
        id: makeUserId("u1"),
        values: { contract_text: "hello", contract_real: 2.5, contract_flag: true },
        returning: userFieldColumns,
        at: at(4),
      });
      assert.deepEqual(Option.getOrThrow(written), {
        contract_text: "hello",
        contract_real: 2.5,
        contract_flag: true,
      });
      const cleared = yield* store.writeFields({
        id: makeUserId("u1"),
        values: { contract_text: null, contract_flag: false },
        returning: userFieldColumns,
        at: at(5),
      });
      assert.deepEqual(Option.getOrThrow(cleared), { contract_real: 2.5, contract_flag: false });
      assert.deepEqual(Option.getOrThrow(yield* store.readFields(makeUserId("u1"), [realColumn])), {
        contract_real: 2.5,
      });
      assert.deepEqual(Option.getOrThrow(yield* store.get(makeUserId("u1"))).updatedAt, at(5));
      assert.equal(
        Option.isNone(
          yield* store.writeFields({
            id: makeUserId("nobody"),
            values: { contract_text: "x" },
            returning: userFieldColumns,
            at: at(6),
          }),
        ),
        true,
      );
      assert.equal(
        Option.isNone(yield* store.readFields(makeUserId("nobody"), userFieldColumns)),
        true,
      );
    }),
  },
  {
    name: "delete removes the user and its declared fields together: true once, false after, and a re-created id starts with none",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      yield* store.writeFields({
        id: makeUserId("u1"),
        values: { contract_text: "kept?" },
        returning: userFieldColumns,
        at: at(1),
      });
      assert.equal(yield* store.delete(makeUserId("u1")), true);
      assert.equal(yield* store.delete(makeUserId("u1")), false);
      assert.equal(Option.isNone(yield* store.get(makeUserId("u1"))), true);
      assert.equal(Option.isNone(yield* store.getByEmail("a@example.com")), true);
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      assert.deepEqual(
        Option.getOrThrow(yield* store.readFields(makeUserId("u1"), userFieldColumns)),
        {},
      );
    }),
  },
  {
    name: "delete under concurrency removes the row exactly once, and writeFields racing it never orphans a field",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
      const deletions = yield* race(store.delete(makeUserId("u1")));
      assert.equal(deletions.filter((removed) => removed).length, 1);
      // Writers and a deleter together: whatever the order, the user is gone and no field outlives it.
      yield* store.insertOrHolder(newUser("u2", { email: "b@example.com" }));
      yield* Effect.all(
        [
          store.delete(makeUserId("u2")),
          ...Array.from({ length: CONCURRENCY }, (_, index) =>
            store.writeFields({
              id: makeUserId("u2"),
              values: { contract_text: `w${index}` },
              returning: userFieldColumns,
              at: at(index),
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(Option.isNone(yield* store.get(makeUserId("u2"))), true);
      yield* store.insertOrHolder(newUser("u2", { email: "b@example.com" }));
      assert.deepEqual(
        Option.getOrThrow(yield* store.readFields(makeUserId("u2"), userFieldColumns)),
        {},
      );
    }),
  },
  {
    name: "listPage orders by (createdAt, id), pages strictly after the cursor, and gives a cursor only when more follow",
    run: Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      // Equal createdAt for b and c: the id breaks the tie.
      yield* store.insertOrHolder(newUser("b", { minutes: 5 }));
      yield* store.insertOrHolder(newUser("c", { minutes: 5 }));
      yield* store.insertOrHolder(newUser("a", { minutes: 9 }));
      yield* store.insertOrHolder(newUser("z", { minutes: 1 }));
      const collected: Array<string> = [];
      let after = Option.none<UserStore.UserCursor>();
      for (let i = 0; i < 6; i++) {
        const page = yield* store.listPage({ after, limit: 3 });
        collected.push(...userIds(page.items));
        if (Option.isNone(page.next)) break;
        after = page.next;
      }
      assert.deepEqual(collected, ["z", "b", "c", "a"]);
      // An exactly-full final page invents no cursor.
      const exact = yield* store.listPage({ after: Option.none(), limit: 4 });
      assert.equal(exact.items.length, 4);
      assert.equal(Option.isNone(exact.next), true);
    }),
  },
];

// ---- sessions -------------------------------------------------------------------------------

type SessionCase = Case<SessionStore.SessionStore>;

const makeSessionId = Schema.decodeUnknownSync(Ids.SessionId);

const newSession = (
  id: string,
  userId: string,
  options: {
    readonly minutes?: number;
    readonly absoluteMinutes?: number;
    readonly idleMinutes?: number;
    readonly amr?: ReadonlyArray<string>;
    readonly actingAs?: SessionStore.ActingAs;
    readonly secretHash?: string;
  } = {},
): SessionStore.NewSession => ({
  id: makeSessionId(id),
  userId: makeUserId(userId),
  secretHash: options.secretHash ?? `hash-${id}`,
  at: at(options.minutes ?? 0),
  absoluteExpiresAt: at((options.minutes ?? 0) + (options.absoluteMinutes ?? 1000)),
  idleExpiresAt: at((options.minutes ?? 0) + (options.idleMinutes ?? 60)),
  ipAddress: Option.none(),
  userAgent: Option.none(),
  actingAs: Option.fromNullishOr(options.actingAs),
  amr: options.amr ?? [],
});

const insertSession = (
  session: SessionStore.NewSession,
  options: { readonly supersedes?: string; readonly maxLive?: number } = {},
) =>
  Effect.flatMap(SessionStore.SessionStore, (store) =>
    store.insert({
      session,
      supersedes: Option.map(Option.fromNullishOr(options.supersedes), makeSessionId),
      maxLive: Option.fromNullishOr(options.maxLive),
    }),
  );

const listLive = (userId: string, minutes: number, limit = 1000) =>
  Effect.flatMap(SessionStore.SessionStore, (store) =>
    store.listLive({
      userId: makeUserId(userId),
      now: at(minutes),
      limit,
      consistency: "authoritative",
    }),
  );

const liveIds = (userId: string, minutes: number) =>
  Effect.map(listLive(userId, minutes), (listing) => listing.items.map((row) => row.id).sort());

const rotateTo = (
  id: string,
  expected: string,
  next: string,
  minutes: number,
  previous: Option.Option<{
    readonly hash: string;
    readonly expiresAt: DateTime.Utc;
  }> = Option.none(),
) =>
  Effect.flatMap(SessionStore.SessionStore, (store) =>
    store.rotate({
      id: makeSessionId(id),
      expectedSecretHash: expected,
      secretHash: next,
      previous,
      lastActiveAt: at(minutes),
      idleExpiresAt: at(minutes + 60),
    }),
  );

/** The `SessionStore` contract (plan 02, ADR-EA-041, ADR-EA-014; BEH-EA-049 to 056, RRS-003, INV-EA-018). */
export const sessions: ReadonlyArray<SessionCase> = [
  {
    name: "insert founds a family, stamps the ambient tenant, and get round-trips every field",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const outcome = yield* Tenant.withTenant("tenant-a")(
        insertSession({
          ...newSession("s1", "u1", {
            amr: ["pwd", "otp"],
            actingAs: { type: "user", id: "admin-1" },
          }),
          ipAddress: Option.some("203.0.113.9"),
          userAgent: Option.some("agent/1.0"),
        }),
      );
      assert.equal(outcome.inserted.familyId, "s1");
      assert.deepEqual(outcome.superseded, Option.none());
      assert.deepEqual(outcome.evicted, []);
      const row = Option.getOrThrow(yield* store.get(makeSessionId("s1")));
      assert.deepEqual(row.tenantId, Option.some("tenant-a"));
      assert.deepEqual(row.amr, ["pwd", "otp"]);
      assert.deepEqual(row.actingAs, Option.some({ type: "user", id: "admin-1" }));
      assert.deepEqual(row.ipAddress, Option.some("203.0.113.9"));
      assert.deepEqual(row.userAgent, Option.some("agent/1.0"));
      assert.deepEqual(row.createdAt, at(0));
      assert.deepEqual(row.authenticatedAt, at(0));
      assert.deepEqual(row.lastActiveAt, at(0));
      assert.deepEqual(row.absoluteExpiresAt, at(1000));
      assert.deepEqual(row.idleExpiresAt, at(60));
      assert.deepEqual(row.previousSecretHash, Option.none());
      assert.deepEqual(row.supersededAt, Option.none());
      assert.equal(Option.isNone(yield* store.get(makeSessionId("missing"))), true);
    }),
  },
  {
    name: "insert with supersedes tombstones a live row of the same user and inherits its family",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("a", "u1"));
      const second = yield* insertSession(newSession("b", "u1", { minutes: 1 }), {
        supersedes: "a",
      });
      assert.equal(second.inserted.familyId, "a");
      const ancestor = Option.getOrThrow(second.superseded);
      assert.equal(ancestor.id, "a");
      assert.equal(ancestor.userId, "u1");
      assert.deepEqual(ancestor.supersededBy, Option.some("b"));
      assert.deepEqual(ancestor.supersededAt, Option.some(at(1)));
      // Tombstoned, not deleted (RRS-003): the row is still there, and no longer live.
      const stored = Option.getOrThrow(yield* store.get(makeSessionId("a")));
      assert.equal(Option.isSome(stored.supersededAt), true);
      assert.deepEqual(yield* liveIds("u1", 2), ["b"]);
      // Rotating again carries the founding family forward.
      const third = yield* insertSession(newSession("c", "u1", { minutes: 2 }), {
        supersedes: "b",
      });
      assert.equal(third.inserted.familyId, "a");
    }),
  },
  {
    name: "insert with supersedes naming another user's, a tombstoned or an absent row founds a fresh family and tombstones nothing (INV-EA-018)",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("victim", "u1"));
      yield* insertSession(newSession("old", "u2"));
      yield* insertSession(newSession("new", "u2", { minutes: 1 }), { supersedes: "old" });
      const foreign = yield* insertSession(newSession("mine", "u3"), { supersedes: "victim" });
      assert.equal(foreign.inserted.familyId, "mine");
      assert.deepEqual(foreign.superseded, Option.none());
      const replay = yield* insertSession(newSession("again", "u2", { minutes: 2 }), {
        supersedes: "old",
      });
      assert.equal(replay.inserted.familyId, "again");
      assert.deepEqual(replay.superseded, Option.none());
      const absent = yield* insertSession(newSession("alone", "u2", { minutes: 2 }), {
        supersedes: "nobody",
      });
      assert.equal(absent.inserted.familyId, "alone");
      assert.deepEqual(absent.superseded, Option.none());
      // The foreign row is untouched.
      assert.deepEqual(
        Option.getOrThrow(yield* store.get(makeSessionId("victim"))).supersededAt,
        Option.none(),
      );
      assert.deepEqual(yield* liveIds("u1", 2), ["victim"]);
    }),
  },
  {
    name: "insert under concurrency: exactly one of 8 inserts naming one ancestor supersedes it",
    run: Effect.gen(function* () {
      yield* insertSession(newSession("a", "u1"));
      const outcomes = yield* Effect.all(
        Array.from({ length: CONCURRENCY }, (_, index) =>
          insertSession(newSession(`child-${index}`, "u1", { minutes: 1 }), { supersedes: "a" }),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter((outcome) => Option.isSome(outcome.superseded)).length, 1);
      const inherited = outcomes.filter((outcome) => outcome.inserted.familyId === "a");
      assert.equal(inherited.length, 1);
    }),
  },
  {
    name: "insert with maxLive evicts the least-recently-active surplus (ties by id), counting only live, non-acting-as rows",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("old", "u1", { minutes: 0 }));
      yield* insertSession(newSession("mid-b", "u1", { minutes: 1 }));
      yield* insertSession(newSession("mid-a", "u1", { minutes: 1 }));
      yield* insertSession(
        newSession("acting", "u1", { minutes: 0, actingAs: { type: "user", id: "adm" } }),
      );
      yield* insertSession(newSession("dead", "u1", { minutes: 0, idleMinutes: 1 }));
      yield* insertSession(newSession("other-user", "u2", { minutes: 0 }));
      // Live non-acting rows at minute 5: old, mid-a, mid-b. maxLive 3 with the new one: evict one.
      const outcome = yield* insertSession(newSession("fresh", "u1", { minutes: 5 }), {
        maxLive: 3,
      });
      assert.deepEqual(outcome.evicted, ["old"]);
      assert.equal(Option.isNone(yield* store.get(makeSessionId("old"))), true);
      // The acting-as, the expired and the other user's rows are never evicted.
      for (const id of ["acting", "dead", "other-user"]) {
        assert.equal(Option.isSome(yield* store.get(makeSessionId(id))), true, id);
      }
      // A tie on lastActiveAt is broken by id: mid-a goes before mid-b.
      const next = yield* insertSession(newSession("fresher", "u1", { minutes: 6 }), {
        maxLive: 3,
      });
      assert.deepEqual(next.evicted, ["mid-a"]);
    }),
  },
  {
    name: "an acting-as insert neither triggers nor is counted by the cap",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("a", "u1"));
      const outcome = yield* insertSession(
        newSession("support", "u1", { minutes: 1, actingAs: { type: "user", id: "adm" } }),
        { maxLive: 1 },
      );
      assert.deepEqual(outcome.evicted, []);
      assert.equal(Option.isSome(yield* store.get(makeSessionId("a"))), true);
    }),
  },
  {
    name: "insert under concurrency with maxLive 2: never more than 3 live at once, and one more insert evicts back to 2 (SMS-003)",
    run: Effect.gen(function* () {
      yield* Effect.all(
        Array.from({ length: CONCURRENCY }, (_, index) =>
          insertSession(newSession(`racer-${index}`, "u1", { minutes: index }), { maxLive: 2 }),
        ),
        { concurrency: "unbounded" },
      );
      const afterRace = (yield* liveIds("u1", 20)).length;
      // A serializing adapter is exact; Postgres' READ COMMITTED may leave one over for a moment.
      assert.equal(afterRace >= 1 && afterRace <= 3, true, `live after the race: ${afterRace}`);
      yield* insertSession(newSession("settle", "u1", { minutes: 30 }), { maxLive: 2 });
      assert.equal((yield* liveIds("u1", 31)).length <= 2, true);
    }),
  },
  {
    name: "rotate swaps once, keeps the previous hash for the grace window, and reports Lost with the row as it is now",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("s1", "u1", { secretHash: "h0" }));
      const grace = Option.some({ hash: "h0", expiresAt: at(10) });
      const first = yield* rotateTo("s1", "h0", "h1", 5, grace);
      assert.equal(first._tag, "Rotated");
      if (first._tag === "Rotated") {
        assert.equal(first.session.secretHash, "h1");
        assert.deepEqual(first.session.previousSecretHash, Option.some("h0"));
        assert.deepEqual(first.session.previousSecretExpiresAt, Option.some(at(10)));
        assert.deepEqual(first.session.lastActiveAt, at(5));
        assert.deepEqual(first.session.idleExpiresAt, at(65));
      }
      // The same swap again: the hash is no longer h0.
      const second = yield* rotateTo("s1", "h0", "h2", 6);
      assert.equal(second._tag, "Lost");
      if (second._tag === "Lost") assert.equal(Option.getOrThrow(second.current).secretHash, "h1");
      assert.equal(Option.getOrThrow(yield* store.get(makeSessionId("s1"))).secretHash, "h1");
      // No previous: a zero grace clears the earlier one.
      yield* rotateTo("s1", "h1", "h3", 7);
      assert.deepEqual(
        Option.getOrThrow(yield* store.get(makeSessionId("s1"))).previousSecretHash,
        Option.none(),
      );
      const absent = yield* rotateTo("nobody", "h0", "h1", 5);
      assert.deepEqual(absent, { _tag: "Lost", current: Option.none() });
    }),
  },
  {
    name: "rotate never rotates a tombstoned row, which is the evidence of reuse",
    run: Effect.gen(function* () {
      yield* insertSession(newSession("a", "u1", { secretHash: "ha" }));
      yield* insertSession(newSession("b", "u1", { minutes: 1 }), { supersedes: "a" });
      const outcome = yield* rotateTo("a", "ha", "hb", 2);
      assert.equal(outcome._tag, "Lost");
      if (outcome._tag === "Lost") {
        assert.equal(Option.isSome(Option.getOrThrow(outcome.current).supersededAt), true);
        assert.equal(Option.getOrThrow(outcome.current).secretHash, "ha");
      }
    }),
  },
  {
    name: "rotate under concurrency: exactly one of 8 swaps against one expected hash is Rotated",
    run: Effect.gen(function* () {
      yield* insertSession(newSession("s1", "u1", { secretHash: "h0" }));
      const outcomes = yield* Effect.all(
        Array.from({ length: CONCURRENCY }, (_, index) => rotateTo("s1", "h0", `next-${index}`, 5)),
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter((outcome) => outcome._tag === "Rotated").length, 1);
    }),
  },
  {
    name: "flagReuse answers the family once, marks the tombstone, deletes the live family and leaves other families alone",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("a", "u1"));
      yield* insertSession(newSession("b", "u1", { minutes: 1 }), { supersedes: "a" });
      yield* insertSession(newSession("c", "u1", { minutes: 2 }), { supersedes: "b" });
      yield* insertSession(newSession("other", "u1", { minutes: 2 }));
      const flagged = yield* store.flagReuse(makeSessionId("a"), at(3));
      assert.deepEqual(Option.getOrThrow(flagged), { familyId: "a", userId: "u1" });
      // Once only.
      assert.equal(Option.isNone(yield* store.flagReuse(makeSessionId("a"), at(4))), true);
      assert.deepEqual(
        Option.getOrThrow(yield* store.get(makeSessionId("a"))).reusedAt,
        Option.some(at(3)),
      );
      // The live member of the family (c) is gone; the tombstones stay; another family is untouched.
      assert.equal(Option.isNone(yield* store.get(makeSessionId("c"))), true);
      assert.equal(Option.isSome(yield* store.get(makeSessionId("b"))), true);
      assert.deepEqual(yield* liveIds("u1", 5), ["other"]);
    }),
  },
  {
    name: "flagReuse on a live, an absent or an already-flagged row does nothing",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("live", "u1"));
      assert.equal(Option.isNone(yield* store.flagReuse(makeSessionId("live"), at(1))), true);
      assert.deepEqual(
        Option.getOrThrow(yield* store.get(makeSessionId("live"))).reusedAt,
        Option.none(),
      );
      assert.equal(Option.isNone(yield* store.flagReuse(makeSessionId("absent"), at(1))), true);
    }),
  },
  {
    name: "flagReuse under concurrency: exactly one of 8 presentations of one tombstone is Some (RRS-003)",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("a", "u1"));
      yield* insertSession(newSession("b", "u1", { minutes: 1 }), { supersedes: "a" });
      const outcomes = yield* race(store.flagReuse(makeSessionId("a"), at(2)));
      assert.equal(outcomes.filter(Option.isSome).length, 1);
    }),
  },
  {
    name: "remove answers the owner once, refuses a foreign owner without touching the row, and says None for an absent one",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("s1", "u1"));
      assert.equal(
        Option.isNone(yield* store.remove(makeSessionId("s1"), Option.some(makeUserId("u2")))),
        true,
      );
      assert.equal(Option.isSome(yield* store.get(makeSessionId("s1"))), true);
      assert.deepEqual(
        yield* store.remove(makeSessionId("s1"), Option.some(makeUserId("u1"))),
        Option.some("u1"),
      );
      assert.equal(Option.isNone(yield* store.remove(makeSessionId("s1"), Option.none())), true);
      yield* insertSession(newSession("s2", "u3"));
      assert.deepEqual(yield* store.remove(makeSessionId("s2"), Option.none()), Option.some("u3"));
    }),
  },
  {
    name: "remove under concurrency: exactly one of 8 removes of one row is Some (TIR-008)",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("s1", "u1"));
      const outcomes = yield* race(store.remove(makeSessionId("s1"), Option.none()));
      assert.equal(outcomes.filter(Option.isSome).length, 1);
    }),
  },
  {
    name: "removeForUser deletes the user's rows, tombstones included, except `keep`, and reports how many",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("a", "u1"));
      yield* insertSession(newSession("b", "u1", { minutes: 1 }), { supersedes: "a" });
      yield* insertSession(newSession("c", "u1", { minutes: 2 }));
      yield* insertSession(newSession("z", "u2"));
      assert.equal(
        yield* store.removeForUser(makeUserId("u1"), Option.some(makeSessionId("c"))),
        2,
      );
      assert.equal(Option.isNone(yield* store.get(makeSessionId("a"))), true);
      assert.equal(Option.isSome(yield* store.get(makeSessionId("c"))), true);
      assert.equal(yield* store.removeForUser(makeUserId("u1"), Option.none()), 1);
      assert.equal(yield* store.removeForUser(makeUserId("u1"), Option.none()), 0);
      assert.equal(Option.isSome(yield* store.get(makeSessionId("z"))), true);
    }),
  },
  {
    name: "listLive is exactly the live rows (a row at its expiry is not live, a tombstone is not), in creation order",
    run: Effect.gen(function* () {
      yield* insertSession(newSession("live-2", "u1", { minutes: 1 }));
      yield* insertSession(newSession("live-1", "u1", { minutes: 0 }));
      yield* insertSession(newSession("idle-edge", "u1", { minutes: 0, idleMinutes: 10 }));
      yield* insertSession(
        newSession("abs-edge", "u1", { minutes: 0, absoluteMinutes: 10, idleMinutes: 500 }),
      );
      yield* insertSession(newSession("rotated", "u1", { minutes: 0 }));
      yield* insertSession(newSession("rotated-to", "u1", { minutes: 1 }), {
        supersedes: "rotated",
      });
      yield* insertSession(newSession("other", "u2", { minutes: 0 }));
      // At minute 10 both edge rows are exactly at an expiry: neither is live.
      const listing = yield* listLive("u1", 10);
      assert.deepEqual(
        listing.items.map((row) => row.id),
        ["live-1", "live-2", "rotated-to"],
      );
      assert.equal(listing.truncated, false);
      // One tick earlier the edge rows are live.
      assert.equal((yield* listLive("u1", 9)).items.length, 5);
    }),
  },
  {
    name: "listLive honours the limit and says so when more exist, and drains more rows than one page holds",
    run: Effect.gen(function* () {
      for (let index = 0; index < 5; index++) {
        yield* insertSession(newSession(`s-${index}`, "u1", { minutes: index }));
      }
      const limited = yield* listLive("u1", 10, 3);
      assert.equal(limited.items.length, 3);
      assert.equal(limited.truncated, true);
      const exact = yield* listLive("u1", 10, 5);
      assert.equal(exact.items.length, 5);
      assert.equal(exact.truncated, false);
      // More rows than the 200 a SQL page holds.
      yield* Effect.forEach(
        Array.from({ length: 250 }, (_, index) => `bulk-${String(index).padStart(3, "0")}`),
        (id) => insertSession(newSession(id, "bulk-user", { minutes: 1 })),
        { concurrency: 1 },
      );
      const everything = yield* listLive("bulk-user", 10, 1000);
      assert.equal(everything.items.length, 250);
      assert.equal(everything.truncated, false);
      const capped = yield* listLive("bulk-user", 10, 240);
      assert.equal(capped.items.length, 240);
      assert.equal(capped.truncated, true);
    }),
  },
  {
    name: "reauthenticate advances authenticatedAt and unions the methods into amr, in order, without duplicates",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("s1", "u1", { amr: ["pwd"] }));
      const first = Option.getOrThrow(
        yield* store.reauthenticate({
          id: makeSessionId("s1"),
          owner: makeUserId("u1"),
          at: at(5),
          addAmr: ["otp", "pwd"],
        }),
      );
      assert.deepEqual(first.amr, ["pwd", "otp"]);
      assert.deepEqual(first.authenticatedAt, at(5));
      assert.deepEqual(first.createdAt, at(0));
      // Nothing to add still advances authenticatedAt.
      const second = Option.getOrThrow(
        yield* store.reauthenticate({
          id: makeSessionId("s1"),
          owner: makeUserId("u1"),
          at: at(6),
          addAmr: [],
        }),
      );
      assert.deepEqual(second.amr, ["pwd", "otp"]);
      assert.deepEqual(second.authenticatedAt, at(6));
    }),
  },
  {
    name: "reauthenticate under concurrency: 8 step-ups each adding a method all land in amr (THS-003)",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("s1", "u1", { amr: ["pwd"] }));
      const methods = Array.from({ length: CONCURRENCY }, (_, index) => `m${index}`);
      yield* Effect.all(
        methods.map((method) =>
          store.reauthenticate({
            id: makeSessionId("s1"),
            owner: makeUserId("u1"),
            at: at(5),
            addAmr: [method],
          }),
        ),
        { concurrency: "unbounded" },
      );
      const row = Option.getOrThrow(yield* store.get(makeSessionId("s1")));
      assert.deepEqual([...row.amr].sort(), ["pwd", ...methods].sort());
    }),
  },
  {
    name: "reauthenticate refuses a tombstoned, expired or foreign session and writes nothing (BEH-EA-319)",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("a", "u1", { amr: ["pwd"] }));
      yield* insertSession(newSession("b", "u1", { minutes: 1 }), { supersedes: "a" });
      yield* insertSession(newSession("short", "u1", { idleMinutes: 5 }));
      const attempt = (id: string, owner: string, minutes: number) =>
        store.reauthenticate({
          id: makeSessionId(id),
          owner: makeUserId(owner),
          at: at(minutes),
          addAmr: ["otp"],
        });
      assert.equal(Option.isNone(yield* attempt("a", "u1", 2)), true);
      assert.equal(Option.isNone(yield* attempt("short", "u1", 5)), true);
      assert.equal(Option.isNone(yield* attempt("b", "u2", 2)), true);
      assert.equal(Option.isNone(yield* attempt("nobody", "u1", 2)), true);
      assert.deepEqual(Option.getOrThrow(yield* store.get(makeSessionId("a"))).amr, ["pwd"]);
      assert.deepEqual(Option.getOrThrow(yield* store.get(makeSessionId("b"))).amr, []);
      assert.deepEqual(
        Option.getOrThrow(yield* store.get(makeSessionId("short"))).authenticatedAt,
        at(0),
      );
    }),
  },
  {
    name: "purgeExpired deletes rows past either expiry, tombstones included, and keeps the rest",
    run: Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* insertSession(newSession("abs", "u1", { absoluteMinutes: 10, idleMinutes: 500 }));
      yield* insertSession(newSession("idle", "u1", { idleMinutes: 10 }));
      yield* insertSession(newSession("keep", "u1", { absoluteMinutes: 500, idleMinutes: 500 }));
      yield* insertSession(newSession("old", "u1", { idleMinutes: 5 }));
      yield* insertSession(newSession("new", "u1", { minutes: 1 }), { supersedes: "old" });
      // A cutoff at 20 minutes: abs (10), idle (10) and the tombstone `old` (idle 5) are past it.
      assert.equal(yield* store.purgeExpired(at(20)), 3);
      for (const id of ["abs", "idle", "old"]) {
        assert.equal(Option.isNone(yield* store.get(makeSessionId(id))), true, id);
      }
      for (const id of ["keep", "new"]) {
        assert.equal(Option.isSome(yield* store.get(makeSessionId(id))), true, id);
      }
      assert.equal(yield* store.purgeExpired(at(20)), 0);
    }),
  },
];
