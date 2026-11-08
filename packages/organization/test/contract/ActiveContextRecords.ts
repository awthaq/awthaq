// Plan 25 ticket 14 (ADR-EA-041 decision 9): `ActiveContextRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. Every write is one upsert (plan 24 C5): racing first writes for a new
// session cannot collide on the primary key. A stale pointer is re-validated on read (BEH-EA-289), never an authority.
import { Users } from "@awthaq/core";
import { RecordsContract, type TestAuth } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "../../src/ActiveContextRecords.ts";
import * as MembershipRecords from "../../src/MembershipRecords.ts";
import * as TeamRecords from "../../src/TeamRecords.ts";
import { ambientOrganization, grant } from "../support.ts";

const alice = Users.UserId("alice");
const bob = Users.UserId("bob");

const member = (userId: Users.UserId, organizationId: string) =>
  MembershipRecords.MembershipRecords.use((records) =>
    records.create({ userId, organizationId, role: ["member"] }),
  ).pipe(Effect.orDie);

const onTeam = (userId: Users.UserId, teamId: string) =>
  TeamRecords.TeamRecords.use((records) => records.addTeamMember({ teamId, userId })).pipe(
    Effect.orDie,
  );

let isolationCounter = 0;
interface Row {
  readonly sessionId: string;
  readonly userId: Users.UserId;
  readonly organizationId: string;
}
const read = (row: Row) =>
  Effect.flatMap(ActiveContextRecords.ActiveContextRecords, (records) =>
    records.findBySessionId(row.sessionId),
  );
/** Runs `change` and reports whether the session's active organization stopped being the row's organization. */
const changed = (
  row: Row,
  change: (
    records: ActiveContextRecords.ActiveContextRecordsShape,
  ) => Effect.Effect<unknown, unknown>,
) =>
  Effect.flatMap(ActiveContextRecords.ActiveContextRecords, (records) =>
    Effect.gen(function* () {
      const before = yield* read(row);
      yield* change(records);
      const after = yield* read(row);
      const active = (found: typeof before) =>
        Option.isSome(found) && Option.isSome(found.value.activeOrganizationId);
      return active(before) && !active(after);
    }),
  );
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";

const isolationCase: TestAuth.TableCase<
  ActiveContextRecords.ActiveContextRecordsShape,
  Row,
  ActiveContextRecords.ActiveContextRecords | MembershipRecords.MembershipRecords
> = {
  table: "organization_active_context",
  insert: Effect.gen(function* () {
    const records = yield* ActiveContextRecords.ActiveContextRecords;
    isolationCounter += 1;
    const organizationId = yield* ambientOrganization;
    const userId = Users.UserId(`isolation-user-${isolationCounter}`);
    const sessionId = `isolation-session-${isolationCounter}`;
    yield* records.setOrganization(sessionId, yield* member(userId, organizationId));
    return { sessionId, userId, organizationId };
  }),
  methods: {
    setOrganization: { insert: true },
    unsetOrganization: {
      derived: "keyed by the caller's own session id; the session is tenant-scoped",
    },
    setTeam: { derived: "keyed by the caller's own session id; the session is tenant-scoped" },
    unsetTeam: { derived: "keyed by the caller's own session id; the session is tenant-scoped" },
    findBySessionId: {
      derived: "keyed by the caller's own session id; the session is tenant-scoped",
    },
    clearOrganization: {
      keyed: {
        run: (row, as) => changed(row, (records) => records.clearOrganization(orgOf(row, as))),
      },
    },
    clearOrganizationForUser: {
      keyed: {
        run: (row, as) =>
          changed(row, (records) => records.clearOrganizationForUser(row.userId, orgOf(row, as))),
      },
    },
    clearTeam: {
      derived: "keyed by a team id the caller already resolved through a tenant-scoped team read",
    },
    deleteAllByUser: {
      crossTenant: {
        run: (row) =>
          Effect.flatMap(ActiveContextRecords.ActiveContextRecords, (records) =>
            Effect.gen(function* () {
              const before = yield* read(row);
              yield* records.deleteAllByUser(grant, row.userId);
              return Option.isSome(before) && Option.isNone(yield* read(row));
            }),
          ),
      },
    },
  },
};

/** Cases arrange their witnesses through the membership and team stores the bundle provides beside it. */
type Witnesses = MembershipRecords.MembershipRecords | TeamRecords.TeamRecords;

export const activeContextRecords = RecordsContract.suite<
  ActiveContextRecords.ActiveContextRecords,
  ActiveContextRecords.ActiveContextRecordsShape,
  Row,
  Witnesses
>(ActiveContextRecords.ActiveContextRecords, {
  operations: {
    setOrganization: {
      atomic: [
        {
          name: "setOrganization then findBySessionId round-trips it (and records the user)",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setOrganization("session-1", yield* member(alice, "org-1"));
            const found = yield* records.findBySessionId("session-1");
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) {
              assert.deepStrictEqual(found.value.activeOrganizationId, Option.some("org-1"));
              assert.deepStrictEqual(found.value.activeTeamId, Option.none());
              assert.deepStrictEqual(found.value.userId, Option.some("alice"));
            }
          }),
        },
      ],
      race: [
        {
          name: "8 first writes for one new session leave one row, none failing (plan 24 C5)",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            const memberships = [];
            for (let n = 0; n < RecordsContract.CONCURRENCY; n++)
              memberships.push(yield* member(alice, `org-${n}`));
            yield* Effect.all(
              memberships.map((membership) => records.setOrganization("session-race", membership)),
              { concurrency: "unbounded" },
            );
            const found = Option.getOrThrow(yield* records.findBySessionId("session-race"));
            assert.isTrue(Option.isSome(found.activeOrganizationId));
          }),
        },
      ],
    },
    unsetOrganization: {
      write: [
        {
          name: "unsetOrganization unsets it without touching activeTeamId",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setOrganization("session-1", yield* member(alice, "org-1"));
            yield* records.setTeam("session-1", yield* onTeam(alice, "team-1"));
            yield* records.unsetOrganization("session-1", alice);
            const found = yield* records.findBySessionId("session-1");
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) {
              assert.deepStrictEqual(found.value.activeOrganizationId, Option.none());
              assert.deepStrictEqual(found.value.activeTeamId, Option.some("team-1"));
            }
          }),
        },
      ],
    },
    setTeam: {
      write: [
        {
          name: "setTeam independently of setOrganization; unsetTeam clears only the team",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setTeam("session-2", yield* onTeam(alice, "team-9"));
            const found = yield* records.findBySessionId("session-2");
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) {
              assert.deepStrictEqual(found.value.activeTeamId, Option.some("team-9"));
              assert.deepStrictEqual(found.value.activeOrganizationId, Option.none());
            }
            yield* records.unsetTeam("session-2", alice);
            const cleared = yield* records.findBySessionId("session-2");
            assert.isTrue(Option.isSome(cleared));
            if (Option.isSome(cleared))
              assert.deepStrictEqual(cleared.value.activeTeamId, Option.none());
          }),
        },
      ],
    },
    unsetTeam: {
      write: [
        {
          name: "clears only the team, keeping the organization",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setOrganization("session-u", yield* member(alice, "org-1"));
            yield* records.setTeam("session-u", yield* onTeam(alice, "team-1"));
            yield* records.unsetTeam("session-u", alice);
            const found = Option.getOrThrow(yield* records.findBySessionId("session-u"));
            assert.deepStrictEqual(found.activeOrganizationId, Option.some("org-1"));
            assert.deepStrictEqual(found.activeTeamId, Option.none());
          }),
        },
      ],
    },
    findBySessionId: {
      read: [
        {
          name: "findBySessionId answers none for an unknown session",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            const found = yield* records.findBySessionId("no-such-session");
            assert.isTrue(Option.isNone(found));
          }),
        },
      ],
    },
    clearOrganization: {
      write: [
        // CWM-003: the organization/team a row points at goes away.
        {
          name: "clearOrganization nulls the org and team of every session on that org only",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setOrganization("s-a", yield* member(alice, "org-1"));
            yield* records.setTeam("s-a", yield* onTeam(alice, "team-1"));
            yield* records.setOrganization("s-b", yield* member(bob, "org-1"));
            yield* records.setOrganization("s-c", yield* member(bob, "org-2"));

            yield* records.clearOrganization("org-1");

            const a = yield* records.findBySessionId("s-a");
            const b = yield* records.findBySessionId("s-b");
            const c = yield* records.findBySessionId("s-c");
            assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeOrganizationId));
            assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeTeamId));
            assert.isTrue(Option.isSome(b) && Option.isNone(b.value.activeOrganizationId));
            assert.isTrue(
              Option.isSome(c) && Option.isSome(c.value.activeOrganizationId),
              "a session on another organization is untouched",
            );
          }),
        },
      ],
    },
    clearOrganizationForUser: {
      write: [
        {
          name: "clearOrganizationForUser only touches that user's sessions on that org",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setOrganization("s-a", yield* member(alice, "org-1"));
            yield* records.setOrganization("s-b", yield* member(bob, "org-1"));

            yield* records.clearOrganizationForUser(alice, "org-1");

            const a = yield* records.findBySessionId("s-a");
            const b = yield* records.findBySessionId("s-b");
            assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeOrganizationId));
            assert.isTrue(Option.isSome(b) && Option.isSome(b.value.activeOrganizationId));
          }),
        },
      ],
    },
    clearTeam: {
      write: [
        {
          name: "clearTeam nulls activeTeamId for sessions on that team, keeping the org",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setOrganization("s-a", yield* member(alice, "org-1"));
            yield* records.setTeam("s-a", yield* onTeam(alice, "team-1"));
            yield* records.setTeam("s-b", yield* onTeam(bob, "team-2"));

            yield* records.clearTeam("team-1");

            const a = yield* records.findBySessionId("s-a");
            const b = yield* records.findBySessionId("s-b");
            assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeTeamId));
            assert.isTrue(Option.isSome(a) && Option.isSome(a.value.activeOrganizationId));
            assert.isTrue(Option.isSome(b) && Option.isSome(b.value.activeTeamId));
          }),
        },
      ],
    },
    deleteAllByUser: {
      write: [
        // DRS-008
        {
          name: "deleteAllByUser removes every session row for that user only",
          run: Effect.gen(function* () {
            const records = yield* ActiveContextRecords.ActiveContextRecords;
            yield* records.setOrganization("s-a1", yield* member(alice, "org-1"));
            yield* records.setOrganization("s-a2", yield* member(alice, "org-2"));
            yield* records.setOrganization("s-b", yield* member(bob, "org-1"));

            yield* records.deleteAllByUser(grant, alice);

            assert.isTrue(Option.isNone(yield* records.findBySessionId("s-a1")));
            assert.isTrue(Option.isNone(yield* records.findBySessionId("s-a2")));
            assert.isTrue(Option.isSome(yield* records.findBySessionId("s-b")));
          }),
        },
      ],
    },
  },
  tenancy: { covers: ["organization_active_context"], cases: [isolationCase] },
});
