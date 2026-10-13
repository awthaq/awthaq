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
// Each port's cases are added with its adapters (`auditLog`, `verification` and `accounts` here; `users`
// and `sessions` follow).

import assert from "node:assert/strict";
import { AccountStore, AuditLogStore, Ids, Tenant, VerificationStore } from "@awthaq/ports";
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
