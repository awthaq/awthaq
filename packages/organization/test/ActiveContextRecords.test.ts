// spec.md's "Active organization/team state": the same
// contract-suite-over-both-layers pattern `MembershipRecords.test.ts` uses.
// `layerSql` here is migrated via `Organization.Organization`'s own real
// `migrations` (`Migrations.run`, `@awthaq/core`) rather than a hand-rolled
// inline `CREATE TABLE` — BAM-002 (.issues/high) verification, the same
// `packages/jwt/test/RevocationStore.test.ts` establishes.
//
// The setters take a witness (MTI-001): a `MembershipRecord` /
// `TeamMembershipRecord` can only come from its own records layer, so the
// suite obtains them from the memory records layers next to the layer under
// test.
import { Migrations, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import { TestSql } from "@awthaq/test";
import { ambientOrganization, grant, vitestFramework } from "./support.ts";

const MemoryLayer = ActiveContextRecords.layerMemory;

const SqlLive = TestSql.layer("organization_ActiveContextRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = ActiveContextRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const Witnesses = Layer.mergeAll(MembershipRecords.layerMemory, TeamRecords.layerMemory).pipe(
  Layer.provide(NodeCrypto.layer),
);

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

const suite = (
  name: string,
  layer: Layer.Layer<ActiveContextRecords.ActiveContextRecords, unknown, never>,
): void => {
  const TestLayer = Layer.mergeAll(layer, Witnesses);
  describe(name, () => {
    it.effect("setOrganization then findBySessionId round-trips it (and records the user)", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("session-1", yield* member(alice, "org-1"));
        const found = yield* records.findBySessionId("session-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.deepStrictEqual(found.value.activeOrganizationId, Option.some("org-1"));
          assert.deepStrictEqual(found.value.activeTeamId, Option.none());
          assert.deepStrictEqual(found.value.userId, Option.some("alice"));
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("unsetOrganization unsets it without touching activeTeamId", () =>
      Effect.gen(function* () {
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
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("setTeam independently of setOrganization; unsetTeam clears only the team", () =>
      Effect.gen(function* () {
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
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("findBySessionId answers none for an unknown session", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        const found = yield* records.findBySessionId("no-such-session");
        assert.isTrue(Option.isNone(found));
      }).pipe(Effect.provide(TestLayer)),
    );

    // CWM-003: the organization/team a row points at goes away.
    it.effect("clearOrganization nulls the org and team of every session on that org only", () =>
      Effect.gen(function* () {
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
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("clearOrganizationForUser only touches that user's sessions on that org", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("s-a", yield* member(alice, "org-1"));
        yield* records.setOrganization("s-b", yield* member(bob, "org-1"));

        yield* records.clearOrganizationForUser(alice, "org-1");

        const a = yield* records.findBySessionId("s-a");
        const b = yield* records.findBySessionId("s-b");
        assert.isTrue(Option.isSome(a) && Option.isNone(a.value.activeOrganizationId));
        assert.isTrue(Option.isSome(b) && Option.isSome(b.value.activeOrganizationId));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("clearTeam nulls activeTeamId for sessions on that team, keeping the org", () =>
      Effect.gen(function* () {
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
      }).pipe(Effect.provide(TestLayer)),
    );

    // DRS-008
    it.effect("deleteAllByUser removes every session row for that user only", () =>
      Effect.gen(function* () {
        const records = yield* ActiveContextRecords.ActiveContextRecords;
        yield* records.setOrganization("s-a1", yield* member(alice, "org-1"));
        yield* records.setOrganization("s-a2", yield* member(alice, "org-2"));
        yield* records.setOrganization("s-b", yield* member(bob, "org-1"));

        yield* records.deleteAllByUser(grant, alice);

        assert.isTrue(Option.isNone(yield* records.findBySessionId("s-a1")));
        assert.isTrue(Option.isNone(yield* records.findBySessionId("s-a2")));
        assert.isTrue(Option.isSome(yield* records.findBySessionId("s-b")));
      }).pipe(Effect.provide(TestLayer)),
    );
  });
};

suite("ActiveContextRecords (layerMemory)", MemoryLayer);
suite("ActiveContextRecords (layerSql)", SqlLayer);

// MTI-001: an active-context write for a non-member is unrepresentable — the
// setters demand a record only the records layers can produce, so a
// hand-built object literal is a compile error. (Type-level only; never run.)
describe("ActiveContextRecords witnesses (type level)", () => {
  it("rejects a hand-built membership witness", () => {
    const handBuilt = {
      id: "m-1",
      userId: alice,
      organizationId: "org-1",
      role: ["owner"],
      createdAt: DateTime.nowUnsafe(),
    };
    const neverRun = (records: ActiveContextRecords.ActiveContextRecordsShape) =>
      // @ts-expect-error a plain object is not a MembershipRecord
      records.setOrganization("session-1", handBuilt);
    assert.isFunction(neverRun);
  });
});

// Plan 05: the tenant-isolation conformance suite. `organization_active_context` is Derived: it has no
// tenant column of its own, a row is reached through its session (a core, partitioned table), so the
// methods keyed by a session id the caller already resolved are `derived`. The ones keyed by an
// organization id are `keyed`, and the erasure sweep across sessions takes a witness.
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

TestAuth.runTenantIsolationTests(vitestFramework, {
  plugin: Organization.Organization,
  covers: ["organization_active_context"],
  adapters: [
    { name: "layerMemory", layer: Layer.mergeAll(MemoryLayer, Witnesses) },
    { name: "layerSql", layer: Layer.mergeAll(SqlLayer, Witnesses) },
  ],
  cases: [isolationCase],
});
