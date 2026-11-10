// @awthaq/test — the users suite of StoreContract (plan 37)
import assert from "node:assert/strict";
import { Ids, SqlTransaction, Tenant, UserStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CONCURRENCY, race } from "../contract.ts";
import { at, makeUserId, opened } from "./fixtures.ts";
import { suite } from "./suite.ts";

/**
 * The declared-field columns (ADR-EA-035) the `users` cases write. A runner whose store keeps them as
 * columns of the user row (SQL) must add exactly these to `users` before it runs the cases.
 */
const textColumn: UserStore.UserFieldColumn = {
  name: "contract_text",
  kind: "text",
};
const realColumn: UserStore.UserFieldColumn = {
  name: "contract_real",
  kind: "real",
};
const flagColumn: UserStore.UserFieldColumn = {
  name: "contract_flag",
  kind: "boolean",
};
export const userFieldColumns: ReadonlyArray<UserStore.UserFieldColumn> = [
  textColumn,
  realColumn,
  flagColumn,
];

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
export const users = suite<
  UserStore.UserStore,
  UserStore.UserStoreShape,
  SqlTransaction.SqlTransaction
>(UserStore.UserStore, {
  operations: {
    insertOrHolder: {
      atomic: [
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
            const emailHeld = yield* store.insertOrHolder(
              newUser("u3", { email: "a@example.com" }),
            );
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
      ],
      race: [
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
      ],
    },
    get: {
      read: [
        {
          name: "the directory is global: a user stamped under tenant A is found by id, email and phone under tenant B and with no tenant (DRS-005)",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* Tenant.withTenant("tenant-a")(
              store.insertOrHolder(
                newUser("u1", { email: "global@example.com", phone: "+15550142" }),
              ),
            );
            const id = makeUserId("u1");
            const phone = makeE164("+15550142");
            const lookups = [
              store.get(id),
              store.getByEmail("global@example.com"),
              store.getByPhone(phone),
            ];
            for (const lookup of lookups) {
              const fromB = yield* Tenant.withTenant("tenant-b")(lookup);
              assert.deepEqual(
                Option.map(fromB, (user) => user.id),
                Option.some("u1"),
              );
              assert.deepEqual(
                Option.map(yield* lookup, (user) => user.id),
                Option.some("u1"),
              );
            }
          }),
        },
      ],
    },
    getByEmail: {
      read: [
        {
          name: "getByEmail finds the holder by the stored key and nobody else",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
            assert.equal(Option.getOrThrow(yield* store.getByEmail("a@example.com")).id, "u1");
            assert.equal(Option.isNone(yield* store.getByEmail("other@example.com")), true);
          }),
        },
      ],
    },
    getByPhone: {
      read: [
        {
          name: "getByPhone finds the holder by the stored key and nobody else",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* store.insertOrHolder(newUser("u2", { phone: "+14155550100" }));
            assert.equal(
              Option.getOrThrow(yield* store.getByPhone(makeE164("+14155550100"))).id,
              "u2",
            );
            assert.equal(Option.isNone(yield* store.getByPhone(makeE164("+14155550199"))), true);
          }),
        },
      ],
    },
    updateProfile: {
      write: [
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
            assert.deepEqual(yield* opened(afterSet.metadata), Option.some("{}"));
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
            assert.deepEqual(yield* opened(kept.metadata), Option.some("{}"));
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
          name: "updateProfile never writes the status, and setStatus is the only writer of it (SCP-001)",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
            yield* store.setStatus({
              id: makeUserId("u1"),
              status: "suspended",
              reason: Option.some("spam"),
              until: Option.some(at(100)),
              at: at(2),
            });
            const renamed = Option.getOrThrow(
              yield* store.updateProfile({
                id: makeUserId("u1"),
                name: "Renamed",
                image: { _tag: "Keep" },
                metadata: { _tag: "Keep" },
                at: at(3),
              }),
            );
            assert.equal(renamed.name, "Renamed");
            assert.equal(renamed.status, "suspended");
            assert.deepEqual(renamed.statusReason, Option.some("spam"));
            assert.deepEqual(renamed.suspendedUntil, Option.some(at(100)));
          }),
        },
      ],
    },
    casIdentity: {
      atomic: [
        {
          name: "casIdentity applies once, reports Stale with the current user when the columns moved, Taken on a collision, Missing for no user",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
            yield* store.insertOrHolder(newUser("u2", { email: "b@example.com" }));
            const before = UserStore.identityOf(
              Option.getOrThrow(yield* store.get(makeUserId("u1"))),
            );
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
              next: {
                ...verified,
                email: Option.some("b@example.com"),
                emailVerified: false,
              },
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
            const anon = UserStore.identityOf(
              Option.getOrThrow(yield* store.get(makeUserId("anon"))),
            );
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
      ],
      race: [
        {
          name: "casIdentity under concurrency: exactly one of 8 identical verifications is Updated",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
            const before = UserStore.identityOf(
              Option.getOrThrow(yield* store.get(makeUserId("u1"))),
            );
            const outcomes = yield* race(
              store.casIdentity({
                id: makeUserId("u1"),
                expected: before,
                next: { ...before, emailVerified: true },
                at: at(1),
              }),
            );
            assert.equal(outcomes.filter((outcome) => outcome._tag === "Updated").length, 1);
            assert.equal(
              outcomes.filter((outcome) => outcome._tag === "Stale").length,
              CONCURRENCY - 1,
            );
          }),
        },
      ],
    },
    setStatus: {
      write: [
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
      ],
    },
    delete: {
      atomic: [
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
      ],
      race: [
        {
          name: "delete under concurrency removes the row exactly once",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
            const deletions = yield* race(store.delete(makeUserId("u1")));
            assert.equal(deletions.filter((removed) => removed).length, 1);
          }),
        },
      ],
    },
    listPage: {
      read: [
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
      ],
    },
    readFields: {
      read: [
        {
          name: "readFields reads the requested declared columns, an empty set for a user with none, and None for no user",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
            yield* store.insertOrHolder(newUser("u1", { email: "a@example.com" }));
            assert.deepEqual(
              Option.getOrThrow(yield* store.readFields(makeUserId("u1"), userFieldColumns)),
              {},
            );
            yield* store.writeFields({
              id: makeUserId("u1"),
              values: { contract_text: "hello", contract_real: 2.5 },
              returning: userFieldColumns,
              at: at(1),
            });
            assert.deepEqual(
              Option.getOrThrow(yield* store.readFields(makeUserId("u1"), [realColumn])),
              {
                contract_real: 2.5,
              },
            );
            assert.equal(
              Option.isNone(yield* store.readFields(makeUserId("nobody"), userFieldColumns)),
              true,
            );
          }),
        },
      ],
    },
    writeFields: {
      atomic: [
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
              values: {
                contract_text: "hello",
                contract_real: 2.5,
                contract_flag: true,
              },
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
            assert.deepEqual(Option.getOrThrow(cleared), {
              contract_real: 2.5,
              contract_flag: false,
            });
            assert.deepEqual(
              Option.getOrThrow(yield* store.readFields(makeUserId("u1"), [realColumn])),
              {
                contract_real: 2.5,
              },
            );
            assert.deepEqual(
              Option.getOrThrow(yield* store.get(makeUserId("u1"))).updatedAt,
              at(5),
            );
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
      ],
      race: [
        {
          name: "writeFields racing delete never orphans a field",
          run: Effect.gen(function* () {
            const store = yield* UserStore.UserStore;
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
      ],
    },
  },
});
