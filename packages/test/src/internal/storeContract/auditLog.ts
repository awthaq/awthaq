// @awthaq/test — the auditLog suite of StoreContract (plan 37)
import assert from "node:assert/strict";
import { AuditLogStore, Tenant } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { race } from "../contract.ts";
import { at } from "./fixtures.ts";
import { suite } from "./suite.ts";

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
export const auditLog = suite(AuditLogStore.AuditLogStore, {
  operations: {
    append: {
      atomic: [
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
      ],
      race: [
        {
          name: "append is idempotent under concurrency: exactly one of 8 racing appends of one id is true",
          run: Effect.gen(function* () {
            const store = yield* AuditLogStore.AuditLogStore;
            const results = yield* race(store.append(auditRow("same")));
            assert.equal(results.filter((stored) => stored).length, 1);
            assert.equal((yield* store.select(noFilter, "authoritative")).length, 1);
          }),
        },
      ],
    },
    select: {
      read: [
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
            assert.deepEqual(
              yield* select({ from: Option.some(at(10)), to: Option.some(at(20)) }),
              ["c", "b"],
            );
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
      ],
    },
    pageAfter: {
      read: [
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
      ],
    },
    rewriteReferencing: {
      write: [
        {
          name: "rewriteReferencing rewrites the rows that name the user as actor or anywhere in the payload, and reports how many",
          run: Effect.gen(function* () {
            const store = yield* AuditLogStore.AuditLogStore;
            yield* store.append(auditRow("actor", { actor: "user-1", payload: '{"x":1}' }));
            yield* store.append(auditRow("payload", { payload: '{"target":"user-1"}' }));
            yield* store.append(
              auditRow("both", { actor: "user-1", payload: '{"target":"user-1"}' }),
            );
            yield* store.append(
              auditRow("other", { actor: "user-2", payload: '{"target":"user-2"}' }),
            );
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
            assert.equal(
              rows.find((row) => row.id === "other")?.payloadJson,
              '{"target":"user-2"}',
            );
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
            for (const id of ["1", "2", "3", "4"])
              yield* store.append(auditRow(id, { actor: "user-1" }));
            let seen = 0;
            const exit = yield* Effect.exit(
              store.rewriteReferencing("user-1", () => {
                seen += 1;
                if (seen === 3) throw new Error("the scrub died on the third row");
                return Option.some({
                  actorUserId: Option.some("erased"),
                  payloadJson: "{}",
                });
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
      ],
    },
    deleteBefore: {
      write: [
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
              yield* store.deleteBefore({
                cutoff: at(120),
                eventTags: Option.none(),
                exceptTags: [],
              }),
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
              yield* store.deleteBefore({
                cutoff: at(1),
                eventTags: Option.none(),
                exceptTags: [],
              }),
              1100,
            );
            assert.deepEqual(yield* store.select(noFilter, "authoritative"), []);
          }),
        },
      ],
    },
  },
});
