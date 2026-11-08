// Plan 25 ticket 24 (ADR-EA-041 decision 9, F11): `RoleAssignments`' first store-level suite, run on memory and
// SQL (Postgres under `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. RRM-005 (BEH-EA-138..141):
// `add` and `remove` answer whether anything changed, so `Roles` audits only a real change; both are idempotent,
// one `Ref.modify` on memory and one statement on SQL (`ON CONFLICT DO NOTHING RETURNING`, `DELETE … RETURNING`).
// These cases replace the store-level copies in `RolesSql.test.ts` and `Roles.test.ts`, whose domain cases stay.
// `roles_assignments` is Global (ADR-EA-025), so the suite has no tenancy cases.
import { Users } from "@awthaq/core";
import { RecordsContract, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as RoleAssignments from "../../src/RoleAssignments.ts";

const userA = Users.UserId("33333333-3333-3333-3333-333333333333");
const userB = Users.UserId("44444444-4444-4444-4444-444444444444");

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

const sorted = (names: ReadonlyArray<string>) => [...names].sort();

export const roleAssignments = RecordsContract.suite(RoleAssignments.RoleAssignments, {
  operations: {
    add: {
      atomic: [
        {
          name: "RRM-005: a new assignment answers true and is read back; an already-held role is a no-op answering false",
          run: Effect.gen(function* () {
            const store = yield* RoleAssignments.RoleAssignments;
            assert.isTrue(yield* store.add(userA, "owner"));
            assert.isFalse(yield* store.add(userA, "owner"));
            assert.deepStrictEqual(yield* store.roleNames(userA), ["owner"]);
          }),
        },
      ],
      race: [
        {
          name: "RRM-005: 8 concurrent assignments of one role: exactly one answers true, one row stored",
          run: Effect.gen(function* () {
            const store = yield* RoleAssignments.RoleAssignments;
            const added = yield* RecordsContract.race(store.add(userA, "owner")).pipe(fineGrained);
            assert.strictEqual(added.filter(Boolean).length, 1);
            assert.deepStrictEqual(yield* store.roleNames(userA), ["owner"]);
            assert.deepStrictEqual(yield* store.holders("owner"), [userA]);
          }),
        },
      ],
    },
    remove: {
      atomic: [
        {
          name: "removes exactly the named role of that user, answering true; an unheld role answers false",
          run: Effect.gen(function* () {
            const store = yield* RoleAssignments.RoleAssignments;
            yield* store.add(userA, "owner");
            yield* store.add(userA, "editor");
            yield* store.add(userB, "owner");
            assert.isTrue(yield* store.remove(userA, "owner"));
            assert.isFalse(yield* store.remove(userA, "owner"));
            assert.isFalse(yield* store.remove(userB, "editor"));
            assert.deepStrictEqual(yield* store.roleNames(userA), ["editor"]);
            assert.deepStrictEqual(yield* store.roleNames(userB), ["owner"]);
          }),
        },
      ],
      race: [
        {
          name: "RRM-005: 8 concurrent revocations of one held role: exactly one answers true",
          run: Effect.gen(function* () {
            const store = yield* RoleAssignments.RoleAssignments;
            yield* store.add(userA, "owner");
            yield* store.add(userA, "editor");
            const removed = yield* RecordsContract.race(store.remove(userA, "owner")).pipe(
              fineGrained,
            );
            assert.strictEqual(removed.filter(Boolean).length, 1);
            assert.deepStrictEqual(yield* store.roleNames(userA), ["editor"]);
          }),
        },
      ],
    },
    roleNames: {
      read: [
        {
          name: "a user's role names; empty for a user with none",
          run: Effect.gen(function* () {
            const store = yield* RoleAssignments.RoleAssignments;
            assert.deepStrictEqual(yield* store.roleNames(userA), []);
            yield* store.add(userA, "owner");
            yield* store.add(userA, "editor");
            yield* store.add(userB, "viewer");
            assert.deepStrictEqual(sorted(yield* store.roleNames(userA)), ["editor", "owner"]);
          }),
        },
      ],
    },
    holders: {
      read: [
        {
          name: "ECS-006: exactly the users holding the role",
          run: Effect.gen(function* () {
            const store = yield* RoleAssignments.RoleAssignments;
            yield* store.add(userA, "owner");
            yield* store.add(userB, "editor");
            assert.deepStrictEqual(yield* store.holders("owner"), [userA]);
            assert.deepStrictEqual(yield* store.holders("nobody"), []);
          }),
        },
      ],
    },
    outside: {
      read: [
        {
          name: "RRM-003: the assignments whose role is not in the catalog; every one for an empty catalog",
          run: Effect.gen(function* () {
            const store = yield* RoleAssignments.RoleAssignments;
            yield* store.add(userA, "owner");
            yield* store.add(userA, "renamed-away");
            yield* store.add(userB, "editor");
            assert.deepStrictEqual(yield* store.outside(["owner", "editor"]), [
              { userId: userA, roleName: "renamed-away" },
            ]);
            assert.strictEqual((yield* store.outside([])).length, 3);
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "UNIQUE(userId, role): a row written around the store does not make add fail",
      run: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* RoleAssignments.RoleAssignments;
        yield* sql`INSERT INTO roles_assignments ("userId", role) VALUES (${userA}, ${"owner"})`;
        assert.isFalse(yield* store.add(userA, "owner"));
        assert.deepStrictEqual(yield* store.roleNames(userA), ["owner"]);
      }),
    },
    {
      name: "plan 05 (ADR-EA-028): an outage is StoreUnavailable naming the operation, never a defect",
      run: Effect.gen(function* () {
        const store = yield* RoleAssignments.RoleAssignments;
        yield* TestSql.injectFailure({
          name: "roles_fail_insert",
          table: "roles_assignments",
          event: "INSERT",
        });
        const failure = yield* store.add(userA, "editor").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "Roles.assign");
      }),
    },
  ],
});
