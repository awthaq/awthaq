// Plan 25 ticket 10 (ADR-EA-041 decision 9): `MembershipRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. The owner guard (BEH-EA-285) and the bounds `create` takes
// (`membershipLimit`, BEH-EA-287; `organizationLimit`, BEH-EA-283) are `atomic`: each is decided inside the write,
// and a `race` case proves it. The listing orders by `(createdAt, id)` in `sortDirection` (plan 24 R1/R2).
import { Users } from "@awthaq/core";
import { RecordsContract, type TestAuth } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as MembershipRecords from "../../src/MembershipRecords.ts";
import { ambientOrganization, grant } from "../support.ts";

type TenantConformanceCase<Shape, Id, R> = TestAuth.TableCase<Shape, Id, R>;

const orgId = "org-1";
const userA = Users.UserId("user-a");
const userB = Users.UserId("user-b");

/** The `_tag` of a failure, or "ok". */
const tagOf = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>): string =>
  Result.isFailure(result) ? result.failure._tag : "ok";

let isolationCounter = 0;
interface Row {
  readonly userId: Users.UserId;
  readonly organizationId: string;
}
/** Runs `change` against the row and reports whether the row stopped being as it was (gone, or its roles changed). */
const changed = (
  row: Row,
  change: (records: MembershipRecords.MembershipRecordsShape) => Effect.Effect<unknown, unknown>,
) =>
  Effect.flatMap(MembershipRecords.MembershipRecords, (records) =>
    Effect.gen(function* () {
      const before = yield* records.findByUserAndOrg(row.userId, row.organizationId);
      yield* change(records).pipe(
        Effect.catchTags({
          MembershipRecordNotFound: () => Effect.void,
        }),
      );
      const after = yield* records.findByUserAndOrg(row.userId, row.organizationId);
      return (
        Option.isSome(before) &&
        (Option.isNone(after) || after.value.role.join() !== before.value.role.join())
      );
    }),
  );
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";

const isolationCase: TenantConformanceCase<
  MembershipRecords.MembershipRecordsShape,
  Row,
  MembershipRecords.MembershipRecords
> = {
  table: "organization_membership",
  insert: Effect.gen(function* () {
    const records = yield* MembershipRecords.MembershipRecords;
    isolationCounter += 1;
    const organizationId = yield* ambientOrganization;
    const userId = Users.UserId(`isolation-user-${isolationCounter}`);
    yield* records.create({ userId, organizationId, role: ["owner"] });
    // A second owner, so removing or demoting the row is not refused as its organization's last owner (BEH-EA-285).
    yield* records.create({
      userId: Users.UserId(`isolation-co-owner-${isolationCounter}`),
      organizationId,
      role: ["owner"],
    });
    return { userId, organizationId };
  }),
  methods: {
    create: { insert: true },
    findByUserAndOrg: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(MembershipRecords.MembershipRecords, (records) =>
            Effect.map(records.findByUserAndOrg(row.userId, orgOf(row, as)), Option.isSome),
          ),
      },
    },
    listByOrganization: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(MembershipRecords.MembershipRecords, (records) =>
            Effect.map(records.listByOrganization(orgOf(row, as)), (rows) =>
              rows.some((found) => found.userId === row.userId),
            ),
          ),
      },
    },
    listByUser: {
      crossTenant: {
        run: (row) =>
          Effect.flatMap(MembershipRecords.MembershipRecords, (records) =>
            Effect.map(records.listByUser(grant, row.userId), (rows) =>
              rows.some((found) => found.organizationId === row.organizationId),
            ),
          ),
      },
    },
    countByOrganization: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(MembershipRecords.MembershipRecords, (records) =>
            Effect.map(records.countByOrganization(orgOf(row, as)), (count) => count > 0),
          ),
      },
    },
    countOwners: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(MembershipRecords.MembershipRecords, (records) =>
            Effect.map(records.countOwners(orgOf(row, as)), (count) => count > 0),
          ),
      },
    },
    updateRole: {
      keyed: {
        run: (row, as) =>
          changed(row, (records) => records.updateRole(row.userId, orgOf(row, as), ["member"])),
      },
    },
    remove: {
      keyed: {
        run: (row, as) => changed(row, (records) => records.remove(row.userId, orgOf(row, as))),
      },
    },
    removeAllForOrganization: {
      keyed: {
        run: (row, as) =>
          changed(row, (records) => records.removeAllForOrganization(orgOf(row, as))),
      },
    },
    deleteAllByUser: {
      crossTenant: {
        run: (row) => changed(row, (records) => records.deleteAllByUser(grant, row.userId)),
      },
    },
  },
};

export const membershipRecords = RecordsContract.suite(MembershipRecords.MembershipRecords, {
  operations: {
    create: {
      atomic: [
        // MTI-003: one membership per (userId, organizationId), enforced by the
        // records layer (memory) / a UNIQUE index (sql) rather than by callers.
        {
          name: "create for an existing (userId, organizationId) fails MembershipRecordAlreadyExists and leaves the original role untouched",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
            const failure = yield* records
              .create({ userId: userA, organizationId: orgId, role: ["member"] })
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "MembershipRecordAlreadyExists");
            const found = yield* records.findByUserAndOrg(userA, orgId);
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) assert.deepStrictEqual(found.value.role, ["owner"]);
            assert.strictEqual(yield* records.countByOrganization(orgId), 1);
          }),
        },
        {
          name: "within refuses at the organization's limit (MembershipRecords/LimitReached) and stores nothing",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create(
              { userId: userA, organizationId: orgId, role: ["owner"] },
              { within: 2 },
            );
            yield* records.create(
              { userId: userB, organizationId: orgId, role: ["member"] },
              { within: 2 },
            );
            const refused = yield* Effect.flip(
              records.create(
                { userId: Users.UserId("user-c"), organizationId: orgId, role: ["member"] },
                { within: 2 },
              ),
            );
            assert.strictEqual(refused._tag, "MembershipRecords/LimitReached");
            assert.strictEqual(yield* records.countByOrganization(orgId), 2);
          }),
        },
        {
          name: "ownedWithin counts the user's memberships holding the role, across organizations",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            const bound = { ownedWithin: { role: "owner", limit: 2, grant } };
            yield* records.create(
              { userId: userA, organizationId: "org-a", role: ["owner"] },
              bound,
            );
            // A membership without the role does not count.
            yield* records.create(
              { userId: userA, organizationId: "org-m", role: ["member"] },
              bound,
            );
            yield* records.create(
              { userId: userA, organizationId: "org-b", role: ["owner"] },
              bound,
            );
            const refused = yield* Effect.flip(
              records.create({ userId: userA, organizationId: "org-c", role: ["owner"] }, bound),
            );
            assert.strictEqual(refused._tag, "MembershipRecords/OwnedLimitReached");
            assert.isTrue(Option.isNone(yield* records.findByUserAndOrg(userA, "org-c")));
          }),
        },
      ],
      race: [
        {
          name: "8 creates racing at within - 1 store exactly one",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.map(
                  Effect.result(
                    records.create(
                      {
                        userId: Users.UserId(`racer-${n}`),
                        organizationId: orgId,
                        role: ["member"],
                      },
                      { within: 2 },
                    ),
                  ),
                  tagOf,
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((tag) => tag === "ok").length, 1);
            assert.strictEqual(yield* records.countByOrganization(orgId), 2);
          }),
        },
        {
          name: "8 creates of owned memberships racing at ownedWithin - 1 store exactly one",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            const bound = { ownedWithin: { role: "owner", limit: 2, grant } };
            yield* records.create({ userId: userA, organizationId: "org-0", role: ["owner"] });
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.map(
                  Effect.result(
                    records.create(
                      { userId: userA, organizationId: `org-r${n}`, role: ["owner"] },
                      bound,
                    ),
                  ),
                  tagOf,
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((tag) => tag === "ok").length, 1);
            assert.strictEqual((yield* records.listByUser(grant, userA)).length, 2);
          }),
        },
      ],
    },
    findByUserAndOrg: {
      read: [
        {
          name: "create then findByUserAndOrg round-trips role",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
            const found = yield* records.findByUserAndOrg(userA, orgId);
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) assert.deepStrictEqual(found.value.role, ["owner"]);
          }),
        },
      ],
    },
    listByOrganization: {
      read: [
        {
          name: "listByOrganization returns every member, oldest-first by default",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
            yield* TestClock.adjust(Duration.millis(1));
            yield* records.create({ userId: userB, organizationId: orgId, role: ["member"] });

            const all = yield* records.listByOrganization(orgId);
            assert.strictEqual(all.length, 2);
            assert.strictEqual(all[0]?.userId, userA);
            assert.strictEqual(all[1]?.userId, userB);
          }),
        },
        {
          name: "honours sortDirection desc, and pages after ordering (plan 24 R1)",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            for (const id of ["m1", "m2", "m3"]) {
              yield* records.create({
                userId: Users.UserId(id),
                organizationId: orgId,
                role: ["member"],
              });
              yield* TestClock.adjust(Duration.millis(1));
            }
            const desc = yield* records.listByOrganization(orgId, { sortDirection: "desc" });
            assert.deepStrictEqual(
              desc.map((row) => row.userId),
              ["m3", "m2", "m1"],
            );
            const page = yield* records.listByOrganization(orgId, {
              sortDirection: "desc",
              offset: 1,
              limit: 1,
            });
            assert.deepStrictEqual(
              page.map((row) => row.userId),
              ["m2"],
            );
            const ascPage = yield* records.listByOrganization(orgId, { offset: 1 });
            assert.deepStrictEqual(
              ascPage.map((row) => row.userId),
              ["m2", "m3"],
            );
          }),
        },
        {
          name: "equal createdAt orders by id, in both directions (plan 24 R2)",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            for (const id of ["t1", "t2", "t3"]) {
              yield* records.create({
                userId: Users.UserId(id),
                organizationId: orgId,
                role: ["member"],
              });
            }
            const asc = yield* records.listByOrganization(orgId);
            const ids = asc.map((row) => row.id);
            assert.deepStrictEqual(ids, [...ids].sort());
            const desc = yield* records.listByOrganization(orgId, { sortDirection: "desc" });
            assert.deepStrictEqual(
              desc.map((row) => row.id),
              [...ids].reverse(),
            );
          }),
        },
      ],
    },
    listByUser: {
      read: [
        {
          name: "listByUser returns every organization a user belongs to",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: "org-1", role: ["owner"] });
            yield* records.create({ userId: userA, organizationId: "org-2", role: ["member"] });
            const found = yield* records.listByUser(grant, userA);
            assert.strictEqual(found.length, 2);
          }),
        },
      ],
    },
    countByOrganization: {
      read: [
        {
          name: "counts only that organization's memberships",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
            yield* records.create({ userId: userB, organizationId: orgId, role: ["member"] });
            yield* records.create({ userId: userA, organizationId: "org-2", role: ["owner"] });
            assert.strictEqual(yield* records.countByOrganization(orgId), 2);
            assert.strictEqual(yield* records.countByOrganization("org-none"), 0);
          }),
        },
      ],
    },
    countOwners: {
      read: [
        // MTI-005: counts are COUNT(*) queries; countOwners must see a role array
        // that merely *contains* owner, and ignore ones that don't.
        {
          name: "countOwners counts only memberships whose role array contains owner",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({
              userId: userA,
              organizationId: orgId,
              role: ["admin", "owner"],
            });
            yield* records.create({ userId: userB, organizationId: orgId, role: ["admin"] });
            yield* records.create({
              userId: Users.UserId("user-c"),
              organizationId: orgId,
              role: ["owner-ish", "coowner"],
            });
            yield* records.create({ userId: userA, organizationId: "org-2", role: ["owner"] });
            assert.strictEqual(yield* records.countOwners(orgId), 1);
            assert.strictEqual(yield* records.countByOrganization(orgId), 3);
          }),
        },
        {
          name: "countOwners counts only memberships holding owner",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
            yield* records.create({
              userId: userB,
              organizationId: orgId,
              role: ["admin", "member"],
            });
            const count = yield* records.countOwners(orgId);
            assert.strictEqual(count, 1);
          }),
        },
      ],
    },
    updateRole: {
      atomic: [
        {
          name: "updateRole replaces the role array; fails for an unknown membership",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["member"] });
            const updated = yield* records.updateRole(userA, orgId, ["admin"]);
            assert.deepStrictEqual(updated.role, ["admin"]);
            const failure = yield* records.updateRole(userB, orgId, ["admin"]).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "MembershipRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "8 owners each demoting themselves concurrently leave exactly one owner",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            const owners = Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
              Users.UserId(`owner-${n}`),
            );
            for (const owner of owners) {
              yield* records.create({ userId: owner, organizationId: orgId, role: ["owner"] });
            }
            const outcomes = yield* Effect.all(
              owners.map((owner) =>
                Effect.map(Effect.result(records.updateRole(owner, orgId, ["admin"])), tagOf),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(yield* records.countOwners(orgId), 1);
            assert.deepStrictEqual(
              outcomes.filter((tag) => tag !== "ok"),
              ["MembershipRecords/LastOwner"],
            );
          }),
        },
      ],
    },
    remove: {
      atomic: [
        {
          name: "remove deletes the membership; a second remove fails",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["member"] });
            yield* records.remove(userA, orgId);
            const found = yield* records.findByUserAndOrg(userA, orgId);
            assert.isTrue(Option.isNone(found));
            const failure = yield* records.remove(userA, orgId).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "MembershipRecordNotFound");
          }),
        },
        {
          name: "updateRole and remove refuse to leave the organization without an owner (MembershipRecords/LastOwner)",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: orgId, role: ["owner"] });
            yield* records.create({ userId: userB, organizationId: orgId, role: ["admin"] });
            const demoted = yield* records.updateRole(userA, orgId, ["admin"]).pipe(Effect.flip);
            assert.strictEqual(demoted._tag, "MembershipRecords/LastOwner");
            const removed = yield* records.remove(userA, orgId).pipe(Effect.flip);
            assert.strictEqual(removed._tag, "MembershipRecords/LastOwner");
            // Keeping owner among other roles, and a non-owner's own writes, are not refused.
            yield* records.updateRole(userA, orgId, ["admin", "owner"]);
            yield* records.remove(userB, orgId);
            assert.strictEqual(yield* records.countOwners(orgId), 1);
          }),
        },
      ],
      race: [
        // BEH-EA-285 (plan 25 tickets 02–03): the owner count and the write are one step on every adapter.
        {
          name: "8 owners removing one another concurrently leave exactly one",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            const owners = Array.from({ length: 8 }, (_, index) => Users.UserId(`owner-${index}`));
            for (const owner of owners) {
              yield* records.create({ userId: owner, organizationId: orgId, role: ["owner"] });
            }
            const outcomes = yield* Effect.all(
              owners.map((owner) =>
                Effect.map(Effect.result(records.remove(owner, orgId)), (result): string =>
                  Result.isFailure(result) ? result.failure._tag : "ok",
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(yield* records.countOwners(orgId), 1);
            assert.strictEqual(outcomes.filter((outcome) => outcome === "ok").length, 7);
            assert.deepStrictEqual(
              outcomes.filter((outcome) => outcome !== "ok"),
              ["MembershipRecords/LastOwner"],
            );
          }),
        },
      ],
    },
    removeAllForOrganization: {
      write: [
        {
          name: "removeAllForOrganization clears every membership for that org, and no other",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: "org-a", role: ["owner"] });
            yield* records.create({ userId: userA, organizationId: "org-b", role: ["owner"] });
            yield* records.removeAllForOrganization("org-a");
            assert.strictEqual((yield* records.listByOrganization("org-a")).length, 0);
            assert.strictEqual((yield* records.listByOrganization("org-b")).length, 1);
          }),
        },
      ],
    },
    deleteAllByUser: {
      write: [
        {
          name: "deletes the user's memberships everywhere, owners included (unguarded by design: erasure)",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: userA, organizationId: "org-a", role: ["owner"] });
            yield* records.create({ userId: userA, organizationId: "org-b", role: ["member"] });
            yield* records.create({ userId: userB, organizationId: "org-a", role: ["member"] });
            yield* records.deleteAllByUser(grant, userA);
            assert.strictEqual((yield* records.listByUser(grant, userA)).length, 0);
            assert.strictEqual(yield* records.countOwners("org-a"), 0);
            assert.strictEqual(yield* records.countByOrganization("org-a"), 1);
          }),
        },
      ],
    },
  },
  tenancy: { covers: ["organization_membership"], cases: [isolationCase] },
});
