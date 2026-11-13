// @awthaq/test — the sessions suite of StoreContract (plan 37)
import assert from "node:assert/strict";
import { Ids, SessionStore, Tenant } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CONCURRENCY, race } from "../contract.ts";
import { at, makeUserId, opened } from "./fixtures.ts";
import { suite } from "./suite.ts";

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
export const sessions = suite(SessionStore.SessionStore, {
  operations: {
    insert: {
      atomic: [
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
            assert.deepEqual(yield* opened(row.ipAddress), Option.some("203.0.113.9"));
            assert.deepEqual(yield* opened(row.userAgent), Option.some("agent/1.0"));
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
            yield* insertSession(newSession("new", "u2", { minutes: 1 }), {
              supersedes: "old",
            });
            const foreign = yield* insertSession(newSession("mine", "u3"), {
              supersedes: "victim",
            });
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
          name: "insert with maxLive evicts the least-recently-active surplus (ties by id), counting only live, non-acting-as rows",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("old", "u1", { minutes: 0 }));
            yield* insertSession(newSession("mid-b", "u1", { minutes: 1 }));
            yield* insertSession(newSession("mid-a", "u1", { minutes: 1 }));
            yield* insertSession(
              newSession("acting", "u1", {
                minutes: 0,
                actingAs: { type: "user", id: "adm" },
              }),
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
              newSession("support", "u1", {
                minutes: 1,
                actingAs: { type: "user", id: "adm" },
              }),
              { maxLive: 1 },
            );
            assert.deepEqual(outcome.evicted, []);
            assert.equal(Option.isSome(yield* store.get(makeSessionId("a"))), true);
          }),
        },
      ],
      race: [
        {
          name: "insert under concurrency: exactly one of 8 inserts naming one ancestor supersedes it",
          run: Effect.gen(function* () {
            yield* insertSession(newSession("a", "u1"));
            const outcomes = yield* Effect.all(
              Array.from({ length: CONCURRENCY }, (_, index) =>
                insertSession(newSession(`child-${index}`, "u1", { minutes: 1 }), {
                  supersedes: "a",
                }),
              ),
              { concurrency: "unbounded" },
            );
            assert.equal(outcomes.filter((outcome) => Option.isSome(outcome.superseded)).length, 1);
            const inherited = outcomes.filter((outcome) => outcome.inserted.familyId === "a");
            assert.equal(inherited.length, 1);
          }),
        },
        {
          name: "insert under concurrency with maxLive 2: never more than 3 live at once, and one more insert evicts back to 2 (SMS-003)",
          run: Effect.gen(function* () {
            yield* Effect.all(
              Array.from({ length: CONCURRENCY }, (_, index) =>
                insertSession(newSession(`racer-${index}`, "u1", { minutes: index }), {
                  maxLive: 2,
                }),
              ),
              { concurrency: "unbounded" },
            );
            const afterRace = (yield* liveIds("u1", 20)).length;
            // A serializing adapter is exact; Postgres' READ COMMITTED may leave one over for a moment.
            assert.equal(
              afterRace >= 1 && afterRace <= 3,
              true,
              `live after the race: ${afterRace}`,
            );
            yield* insertSession(newSession("settle", "u1", { minutes: 30 }), {
              maxLive: 2,
            });
            assert.equal((yield* liveIds("u1", 31)).length <= 2, true);
          }),
        },
      ],
    },
    get: {
      read: [
        {
          name: "get reads a stored row back by id and is None for an absent id",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("s1", "u1"));
            const row = Option.getOrThrow(yield* store.get(makeSessionId("s1")));
            assert.equal(row.id, "s1");
            assert.equal(row.userId, "u1");
            assert.equal(Option.isNone(yield* store.get(makeSessionId("missing"))), true);
          }),
        },
      ],
    },
    rotate: {
      atomic: [
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
            if (second._tag === "Lost")
              assert.equal(Option.getOrThrow(second.current).secretHash, "h1");
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
            yield* insertSession(newSession("b", "u1", { minutes: 1 }), {
              supersedes: "a",
            });
            const outcome = yield* rotateTo("a", "ha", "hb", 2);
            assert.equal(outcome._tag, "Lost");
            if (outcome._tag === "Lost") {
              assert.equal(Option.isSome(Option.getOrThrow(outcome.current).supersededAt), true);
              assert.equal(Option.getOrThrow(outcome.current).secretHash, "ha");
            }
          }),
        },
      ],
      race: [
        {
          name: "rotate under concurrency: exactly one of 8 swaps against one expected hash is Rotated",
          run: Effect.gen(function* () {
            yield* insertSession(newSession("s1", "u1", { secretHash: "h0" }));
            const outcomes = yield* Effect.all(
              Array.from({ length: CONCURRENCY }, (_, index) =>
                rotateTo("s1", "h0", `next-${index}`, 5),
              ),
              { concurrency: "unbounded" },
            );
            assert.equal(outcomes.filter((outcome) => outcome._tag === "Rotated").length, 1);
          }),
        },
      ],
    },
    flagReuse: {
      atomic: [
        {
          name: "flagReuse answers the family once, marks the tombstone, deletes the live family and leaves other families alone",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("a", "u1"));
            yield* insertSession(newSession("b", "u1", { minutes: 1 }), {
              supersedes: "a",
            });
            yield* insertSession(newSession("c", "u1", { minutes: 2 }), {
              supersedes: "b",
            });
            yield* insertSession(newSession("other", "u1", { minutes: 2 }));
            const flagged = yield* store.flagReuse(makeSessionId("a"), at(3));
            assert.deepEqual(Option.getOrThrow(flagged), {
              familyId: "a",
              userId: "u1",
            });
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
            assert.equal(
              Option.isNone(yield* store.flagReuse(makeSessionId("absent"), at(1))),
              true,
            );
          }),
        },
      ],
      race: [
        {
          name: "flagReuse under concurrency: exactly one of 8 presentations of one tombstone is Some (RRS-003)",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("a", "u1"));
            yield* insertSession(newSession("b", "u1", { minutes: 1 }), {
              supersedes: "a",
            });
            const outcomes = yield* race(store.flagReuse(makeSessionId("a"), at(2)));
            assert.equal(outcomes.filter(Option.isSome).length, 1);
          }),
        },
      ],
    },
    remove: {
      atomic: [
        {
          name: "remove answers the owner once, refuses a foreign owner without touching the row, and says None for an absent one",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("s1", "u1"));
            assert.equal(
              Option.isNone(
                yield* store.remove(makeSessionId("s1"), Option.some(makeUserId("u2"))),
              ),
              true,
            );
            assert.equal(Option.isSome(yield* store.get(makeSessionId("s1"))), true);
            assert.deepEqual(
              yield* store.remove(makeSessionId("s1"), Option.some(makeUserId("u1"))),
              Option.some("u1"),
            );
            assert.equal(
              Option.isNone(yield* store.remove(makeSessionId("s1"), Option.none())),
              true,
            );
            yield* insertSession(newSession("s2", "u3"));
            assert.deepEqual(
              yield* store.remove(makeSessionId("s2"), Option.none()),
              Option.some("u3"),
            );
          }),
        },
      ],
      race: [
        {
          name: "remove under concurrency: exactly one of 8 removes of one row is Some (TIR-008)",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("s1", "u1"));
            const outcomes = yield* race(store.remove(makeSessionId("s1"), Option.none()));
            assert.equal(outcomes.filter(Option.isSome).length, 1);
          }),
        },
      ],
    },
    removeForUser: {
      write: [
        {
          name: "removeForUser deletes the user's rows, tombstones included, except `keep`, and reports how many",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("a", "u1"));
            yield* insertSession(newSession("b", "u1", { minutes: 1 }), {
              supersedes: "a",
            });
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
      ],
    },
    listLive: {
      read: [
        {
          name: "listLive is exactly the live rows (a row at its expiry is not live, a tombstone is not), in creation order",
          run: Effect.gen(function* () {
            yield* insertSession(newSession("live-2", "u1", { minutes: 1 }));
            yield* insertSession(newSession("live-1", "u1", { minutes: 0 }));
            yield* insertSession(newSession("idle-edge", "u1", { minutes: 0, idleMinutes: 10 }));
            yield* insertSession(
              newSession("abs-edge", "u1", {
                minutes: 0,
                absoluteMinutes: 10,
                idleMinutes: 500,
              }),
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
      ],
    },
    reauthenticate: {
      atomic: [
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
          name: "reauthenticate refuses a tombstoned, expired or foreign session and writes nothing (BEH-EA-319)",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(newSession("a", "u1", { amr: ["pwd"] }));
            yield* insertSession(newSession("b", "u1", { minutes: 1 }), {
              supersedes: "a",
            });
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
      ],
      race: [
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
      ],
    },
    purgeExpired: {
      write: [
        {
          name: "purgeExpired deletes rows past either expiry, tombstones included, and keeps the rest",
          run: Effect.gen(function* () {
            const store = yield* SessionStore.SessionStore;
            yield* insertSession(
              newSession("abs", "u1", { absoluteMinutes: 10, idleMinutes: 500 }),
            );
            yield* insertSession(newSession("idle", "u1", { idleMinutes: 10 }));
            yield* insertSession(
              newSession("keep", "u1", { absoluteMinutes: 500, idleMinutes: 500 }),
            );
            yield* insertSession(newSession("old", "u1", { idleMinutes: 5 }));
            yield* insertSession(newSession("new", "u1", { minutes: 1 }), {
              supersedes: "old",
            });
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
      ],
    },
  },
});
