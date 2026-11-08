// Plan 04 (ADR-EA-040): `OrganizationMembers`, tested at its own interface, with no principal. The
// owner invariant, the membership limit, role names, the `Bound`, the veto, the removal cascade and
// the hook order are proved here; the SAML role mapping's cases (BEH-EA-316) live here too, since
// `setRoles` is its one implementation. `Organization.test.ts` keeps only the authorization half.
import { Auth, AuditLog, HookPoint, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationAuthority from "../src/OrganizationAuthority.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMembers from "../src/OrganizationMembers.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import { grant } from "./support.ts";

const built = Auth.make([Organization.Organization]);

const NoTaps = Layer.empty;
const buildLayer = (
  config: Partial<Organization.OrganizationConfigShape> = {},
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = NoTaps,
) => TestAuth.layer(built, { services: Organization.config(config), taps });

const application = OrganizationActor.application("OrganizationMembers.test");
const unbounded = OrganizationActor.Bound.Unbounded();
const userId = Users.UserId;

/** An organization with its creator as the only owner (arranged through the records). */
const arrange = Effect.gen(function* () {
  const orgs = yield* OrganizationRecords.OrganizationRecords;
  const records = yield* MembershipRecords.MembershipRecords;
  const members = yield* OrganizationMembers.OrganizationMembers;
  const org = yield* orgs.create({ name: "Acme", slug: "acme" });
  yield* records.create({ userId: userId("owner-1"), organizationId: org.id, role: ["owner"] });
  return { org, orgs, members, records };
});

const flipTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const rolesOf = (organizationId: string, id: string) =>
  Effect.flatMap(OrganizationMembers.OrganizationMembers, (members) =>
    members.find(organizationId, userId(id)),
  ).pipe(Effect.map((found) => Option.map(found, (row) => row.role)));

/** The `Bound` of a source whose most is what the named roles hold, as a SAML mapping derives it. */
const boundOf = (organizationId: string, roles: ReadonlyArray<string>) =>
  Effect.flatMap(OrganizationAuthority.OrganizationAuthority, (authority) =>
    authority.ceilingOf(organizationId, roles),
  ).pipe(Effect.orDie);

describe("OrganizationMembers.add", () => {
  it.effect(
    "adds a member, refuses a duplicate, an unknown role and a suspended organization",
    () =>
      Effect.gen(function* () {
        const { org, orgs, members } = yield* arrange;
        const added = yield* members.add(application, {
          organizationId: org.id,
          userId: userId("u1"),
          role: ["member"],
          bound: unbounded,
        });
        assert.deepStrictEqual(added.role, ["member"]);
        assert.strictEqual(
          yield* flipTag(
            members.add(application, {
              organizationId: org.id,
              userId: userId("u1"),
              role: ["admin"],
              bound: unbounded,
            }),
          ),
          "AlreadyMember",
        );
        assert.deepStrictEqual(yield* rolesOf(org.id, "u1"), Option.some(["member"]));
        assert.strictEqual(
          yield* flipTag(
            members.add(application, {
              organizationId: org.id,
              userId: userId("u2"),
              role: ["wizard"],
              bound: unbounded,
            }),
          ),
          "UnknownOrgRole",
        );
        yield* orgs.setSuspended(grant, org.id, Option.some(yield* DateTime.now));
        assert.strictEqual(
          yield* flipTag(
            members.add(application, {
              organizationId: org.id,
              userId: userId("u3"),
              role: ["member"],
              bound: unbounded,
            }),
          ),
          "OrganizationNotFound",
        );
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("respects membershipLimit, and a limitsFor override for one organization", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      const add = (id: string) =>
        members.add(application, {
          organizationId: org.id,
          userId: userId(id),
          role: ["member"],
          bound: unbounded,
        });
      yield* add("u1");
      assert.strictEqual(yield* flipTag(add("u2")), "MembershipLimitReached");
    }).pipe(Effect.provide(buildLayer({ membershipLimit: 2 }))),
  );

  it.effect("a Ceiling refuses a role that confers more than it holds; Unbounded admits it", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      const bound = yield* boundOf(org.id, ["admin"]);
      assert.strictEqual(
        yield* flipTag(
          members.add(application, {
            organizationId: org.id,
            userId: userId("u1"),
            role: ["owner"],
            bound,
          }),
        ),
        "RolePermissionEscalation",
      );
      assert.isTrue(Option.isNone(yield* members.find(org.id, userId("u1"))));
      yield* members.add(application, {
        organizationId: org.id,
        userId: userId("u1"),
        role: ["owner"],
        bound: unbounded,
      });
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a veto aborts with the point's id, and a veto that amends the roles is bounded", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      const aborted = yield* members
        .add(application, {
          organizationId: org.id,
          userId: userId("blocked"),
          role: ["member"],
          bound: unbounded,
        })
        .pipe(Effect.flip);
      assert.strictEqual(aborted._tag, "HookAborted");
      if (aborted._tag === "HookAborted") {
        assert.strictEqual(aborted.point, OrganizationHooks.BeforeAddMember.id);
      }
      // A tap rewrites a member to an owner; a member-ceiling cannot confer it.
      const bound = yield* boundOf(org.id, ["member"]);
      assert.strictEqual(
        yield* flipTag(
          members.add(application, {
            organizationId: org.id,
            userId: userId("sneaky"),
            role: ["member"],
            bound,
          }),
        ),
        "RolePermissionEscalation",
      );
      assert.isTrue(Option.isNone(yield* members.find(org.id, userId("sneaky"))));
    }).pipe(
      Effect.provide(
        buildLayer(
          {},
          OrganizationHooks.BeforeAddMember.tap((input) =>
            input.userId === "blocked"
              ? Effect.fail(new HookPoint.HookAbort({ code: "NO" }))
              : input.userId === "sneaky"
                ? Effect.succeed({ ...input, role: ["owner"] })
                : Effect.succeed(input),
          ),
        ),
      ),
    ),
  );

  it.effect("the observe point carries the actor", () => {
    const seen: Array<string> = [];
    return Effect.gen(function* () {
      const { org, members } = yield* arrange;
      yield* members.add(OrganizationActor.directory("conn-1"), {
        organizationId: org.id,
        userId: userId("u1"),
        role: ["member"],
        bound: unbounded,
      });
      assert.deepStrictEqual(seen, ["Directory"]);
    }).pipe(
      Effect.provide(
        buildLayer(
          {},
          OrganizationHooks.AfterAddMember.tap((input) => {
            seen.push(input.actor._tag);
            return Effect.void;
          }),
        ),
      ),
    );
  });
});

// BEH-EA-316: `setRoles` is the one implementation behind an HTTP role change and a SAML role mapping.
describe("OrganizationMembers.setRoles", () => {
  it.effect("adds a membership within the ceiling and refuses one above it, adding nothing", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      const member = yield* boundOf(org.id, ["member"]);
      const added = yield* members.setRoles(application, {
        organizationId: org.id,
        userId: userId("idp-user"),
        roles: ["member"],
        bound: member,
        ifAbsent: "add",
      });
      assert.strictEqual(added.change, "added");
      assert.deepStrictEqual(yield* rolesOf(org.id, "idp-user"), Option.some(["member"]));
      assert.strictEqual(
        yield* flipTag(
          members.setRoles(application, {
            organizationId: org.id,
            userId: userId("greedy"),
            roles: ["owner"],
            bound: member,
            ifAbsent: "add",
          }),
        ),
        "RolePermissionEscalation",
      );
      assert.deepStrictEqual(yield* rolesOf(org.id, "greedy"), Option.none());
      assert.strictEqual(
        yield* flipTag(
          members.setRoles(application, {
            organizationId: org.id,
            userId: userId("greedy"),
            roles: ["wizard"],
            bound: yield* boundOf(org.id, ["owner"]),
            ifAbsent: "add",
          }),
        ),
        "UnknownOrgRole",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("ifAbsent: fail is MembershipNotFound", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      assert.strictEqual(
        yield* flipTag(
          members.setRoles(application, {
            organizationId: org.id,
            userId: userId("nobody"),
            roles: ["member"],
            bound: unbounded,
            ifAbsent: "fail",
          }),
        ),
        "MembershipNotFound",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "re-roles within the ceiling, and an unchanged set is a no-op with no veto or observer (D5)",
    () => {
      const observed: Array<string> = [];
      return Effect.gen(function* () {
        const { org, members } = yield* arrange;
        const admin = yield* boundOf(org.id, ["admin"]);
        const set = (roles: ReadonlyArray<string>) =>
          members.setRoles(application, {
            organizationId: org.id,
            userId: userId("idp-user"),
            roles,
            bound: admin,
            ifAbsent: "add",
          });
        yield* set(["member"]);
        assert.strictEqual((yield* set(["admin"])).change, "updated");
        const updates = observed.length;
        assert.strictEqual((yield* set(["admin"])).change, "unchanged");
        assert.strictEqual(observed.length, updates);
        assert.strictEqual((yield* set(["member"])).change, "updated");
      }).pipe(
        Effect.provide(
          buildLayer(
            {},
            OrganizationHooks.AfterUpdateMemberRole.tap(() => {
              observed.push("updated");
              return Effect.void;
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "never reshapes a member who out-privileges the source, nor demotes the last owner",
    () =>
      Effect.gen(function* () {
        const { org, members } = yield* arrange;
        const outranked = yield* flipTag(
          members.setRoles(application, {
            organizationId: org.id,
            userId: userId("owner-1"),
            roles: ["member"],
            bound: yield* boundOf(org.id, ["member"]),
            ifAbsent: "fail",
          }),
        );
        assert.strictEqual(outranked, "RolePermissionEscalation");
        assert.deepStrictEqual(yield* rolesOf(org.id, "owner-1"), Option.some(["owner"]));
        const last = yield* flipTag(
          members.setRoles(application, {
            organizationId: org.id,
            userId: userId("owner-1"),
            roles: ["member"],
            bound: yield* boundOf(org.id, ["owner"]),
            ifAbsent: "fail",
          }),
        );
        assert.strictEqual(last, "OwnerInvariantViolation");
        assert.deepStrictEqual(yield* rolesOf(org.id, "owner-1"), Option.some(["owner"]));
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a veto tap that amends the roles beyond the ceiling is refused", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      yield* members.add(application, {
        organizationId: org.id,
        userId: userId("u1"),
        role: ["member"],
        bound: unbounded,
      });
      assert.strictEqual(
        yield* flipTag(
          members.setRoles(application, {
            organizationId: org.id,
            userId: userId("u1"),
            roles: ["admin"],
            bound: yield* boundOf(org.id, ["admin"]),
            ifAbsent: "fail",
          }),
        ),
        "RolePermissionEscalation",
      );
      assert.deepStrictEqual(yield* rolesOf(org.id, "u1"), Option.some(["member"]));
    }).pipe(
      Effect.provide(
        buildLayer(
          {},
          OrganizationHooks.BeforeUpdateMemberRole.tap((input) =>
            Effect.succeed({ ...input, role: ["owner"] }),
          ),
        ),
      ),
    ),
  );
});

describe("OrganizationMembers.remove", () => {
  it.effect("refuses to remove the last owner, and allows it once another owner exists", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      assert.strictEqual(
        yield* flipTag(
          members.remove(application, { organizationId: org.id, userId: userId("owner-1") }),
        ),
        "OwnerInvariantViolation",
      );
      yield* members.add(application, {
        organizationId: org.id,
        userId: userId("owner-2"),
        role: ["owner"],
        bound: unbounded,
      });
      yield* members.remove(application, { organizationId: org.id, userId: userId("owner-1") });
      assert.isTrue(Option.isNone(yield* members.find(org.id, userId("owner-1"))));
      assert.strictEqual(
        yield* flipTag(
          members.remove(application, { organizationId: org.id, userId: userId("owner-1") }),
        ),
        "MembershipNotFound",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "drops the team memberships and the active pointer, announcing each team departure before AfterRemoveMember",
    () => {
      const order: Array<string> = [];
      return Effect.gen(function* () {
        const { org, members } = yield* arrange;
        const teams = yield* TeamRecords.TeamRecords;
        const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
        yield* members.add(application, {
          organizationId: org.id,
          userId: userId("u1"),
          role: ["member"],
          bound: unbounded,
        });
        const team = yield* teams.createTeam({ organizationId: org.id, name: "Eng" });
        yield* teams.addTeamMember({ teamId: team.id, userId: userId("u1") });
        const membership = Option.getOrThrow(yield* members.find(org.id, userId("u1")));
        yield* activeContext.setOrganization("s1", membership);
        yield* members.remove(OrganizationActor.ActorSchema.cases.User.make({ userId: "u1" }), {
          organizationId: org.id,
          userId: userId("u1"),
        });
        assert.deepStrictEqual(order, ["teamMemberRemoved", "memberRemoved"]);
        assert.deepStrictEqual(yield* teams.listTeamsByUser(org.id, userId("u1")), []);
        const active = Option.getOrThrow(yield* activeContext.findBySessionId("s1"));
        assert.isTrue(Option.isNone(active.activeOrganizationId));
      }).pipe(
        Effect.provide(
          buildLayer(
            {},
            Layer.mergeAll(
              OrganizationHooks.AfterRemoveTeamMember.tap(() => {
                order.push("teamMemberRemoved");
                return Effect.void;
              }),
              OrganizationHooks.AfterRemoveMember.tap(() => {
                order.push("memberRemoved");
                return Effect.void;
              }),
            ),
          ),
        ),
      );
    },
  );

  it.effect("a veto aborts the removal and nothing is dropped", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      yield* members.add(application, {
        organizationId: org.id,
        userId: userId("u1"),
        role: ["member"],
        bound: unbounded,
      });
      assert.strictEqual(
        yield* flipTag(
          members.remove(application, { organizationId: org.id, userId: userId("u1") }),
        ),
        "HookAborted",
      );
      assert.isTrue(Option.isSome(yield* members.find(org.id, userId("u1"))));
    }).pipe(
      Effect.provide(
        buildLayer(
          {},
          OrganizationHooks.BeforeRemoveMember.tap(() =>
            Effect.fail(new HookPoint.HookAbort({ code: "KEEP" })),
          ),
        ),
      ),
    ),
  );

  it.effect("the audit trail names the acting user, and no user when a directory acted (F11)", () =>
    Effect.gen(function* () {
      const { org, members } = yield* arrange;
      for (const id of ["u1", "u2"]) {
        yield* members.add(application, {
          organizationId: org.id,
          userId: userId(id),
          role: ["member"],
          bound: unbounded,
        });
      }
      const admin = OrganizationActor.ActorSchema.cases.User.make({ userId: "admin-1" });
      yield* members.remove(admin, { organizationId: org.id, userId: userId("u1") });
      yield* members.remove(OrganizationActor.directory("conn-1"), {
        organizationId: org.id,
        userId: userId("u2"),
      });
      const rows = yield* (yield* AuditLog.AuditLog).list({
        eventTag: "auth.organization.memberRemoved",
      });
      // The subject was removed; the actor is who did it (newest first: the directory, then the admin).
      assert.deepStrictEqual(
        rows.map((row) => row.actorUserId),
        [Option.none(), Option.some("admin-1")],
      );
    }).pipe(Effect.provide(buildLayer())),
  );
});

/**
 * A veto handler that holds every caller until `parties` of them have arrived, then lets them all through: each
 * caller's pre-check has run before any of them writes. A deterministic interleaving, not a timing race.
 */
const barrier = (parties: number) => {
  const arrived = Ref.makeUnsafe(0);
  const latch = Latch.makeUnsafe(false);
  return <A>(input: A) =>
    Ref.updateAndGet(arrived, (count) => count + 1).pipe(
      Effect.flatMap((count) => (count >= parties ? latch.open : Effect.void)),
      Effect.andThen(latch.await),
      Effect.as(input),
    );
};

/** The `_tag` of a failure, or "ok". */
const outcomeOf = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>): string =>
  Result.isFailure(result) ? result.failure._tag : "ok";

/** An organization with two owners (arranged through the records). */
const arrangeTwoOwners = (slug: string) =>
  Effect.gen(function* () {
    const orgs = yield* OrganizationRecords.OrganizationRecords;
    const records = yield* MembershipRecords.MembershipRecords;
    const members = yield* OrganizationMembers.OrganizationMembers;
    const org = yield* orgs.create({ name: slug, slug });
    for (const id of ["owner-1", "owner-2"]) {
      yield* records.create({ userId: userId(id), organizationId: org.id, role: ["owner"] });
    }
    return { org, members, records };
  });

// BEH-EA-285 under concurrency (plan 25 tickets 02–03): the owner count and the membership write are one step, so
// two owners racing to remove (or demote) each other leave exactly one owner, on every adapter. The Postgres run
// (`pnpm test:pg`) is the one that matters: a transaction alone does not serialize the count under READ COMMITTED.
for (const mode of TestAuth.recordModes) {
  describe(`OrganizationMembers owner invariant under concurrency (${mode} records)`, () => {
    const raceLayer = (
      taps: Layer.Layer<
        never,
        never,
        Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
      > = NoTaps,
    ) =>
      mode === "sql"
        ? TestAuth.layer(built, {
            records: "sql",
            suite: "organization_members_race",
            services: Organization.config({}),
            taps,
          })
        : buildLayer({}, taps);

    it.effect(
      "two owners removing each other leave exactly one owner; the loser is OwnerInvariantViolation",
      () => {
        const hold = barrier(2);
        return Effect.gen(function* () {
          const { org, members, records } = yield* arrangeTwoOwners("race-remove");
          const outcomes = yield* Effect.all(
            [
              members.remove(application, { organizationId: org.id, userId: userId("owner-1") }),
              members.remove(application, { organizationId: org.id, userId: userId("owner-2") }),
            ].map((removal) => Effect.map(Effect.result(removal), outcomeOf)),
            { concurrency: "unbounded" },
          );
          assert.strictEqual(yield* records.countOwners(org.id), 1);
          assert.deepStrictEqual([...outcomes].sort(), ["OwnerInvariantViolation", "ok"]);
        }).pipe(Effect.provide(raceLayer(OrganizationHooks.BeforeRemoveMember.tap(hold))));
      },
    );

    it.effect("an owner demoting the other while being removed leaves one owner", () => {
      const hold = barrier(2);
      return Effect.gen(function* () {
        const { org, members, records } = yield* arrangeTwoOwners("race-demote");
        const outcomes = yield* Effect.all(
          [
            Effect.map(
              Effect.result(
                members.setRoles(application, {
                  organizationId: org.id,
                  userId: userId("owner-1"),
                  roles: ["admin"],
                  bound: unbounded,
                  ifAbsent: "fail",
                }),
              ),
              outcomeOf,
            ),
            Effect.map(
              Effect.result(
                members.remove(application, { organizationId: org.id, userId: userId("owner-2") }),
              ),
              outcomeOf,
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(yield* records.countOwners(org.id), 1);
        assert.deepStrictEqual([...outcomes].sort(), ["OwnerInvariantViolation", "ok"]);
      }).pipe(
        Effect.provide(
          raceLayer(
            Layer.mergeAll(
              OrganizationHooks.BeforeUpdateMemberRole.tap(hold),
              OrganizationHooks.BeforeRemoveMember.tap(hold),
            ),
          ),
        ),
      );
    });

    it.effect(
      "two removals of the same member: one succeeds, the other is MembershipNotFound, never a defect",
      () => {
        const hold = barrier(2);
        return Effect.gen(function* () {
          const { org, members } = yield* arrangeTwoOwners("race-same-member");
          yield* members.add(application, {
            organizationId: org.id,
            userId: userId("u1"),
            role: ["member"],
            bound: unbounded,
          });
          const removal = members.remove(application, {
            organizationId: org.id,
            userId: userId("u1"),
          });
          const outcomes = yield* Effect.all(
            [removal, removal].map((attempt) => Effect.map(Effect.result(attempt), outcomeOf)),
            { concurrency: "unbounded" },
          );
          assert.deepStrictEqual([...outcomes].sort(), ["MembershipNotFound", "ok"]);
          assert.isTrue(Option.isNone(yield* members.find(org.id, userId("u1"))));
        }).pipe(Effect.provide(raceLayer(OrganizationHooks.BeforeRemoveMember.tap(hold))));
      },
    );

    it.effect("natural race, 8 rounds, no hook: every round leaves an owner", () =>
      Effect.gen(function* () {
        for (let round = 0; round < 8; round++) {
          const { org, members, records } = yield* arrangeTwoOwners(`race-natural-${round}`);
          yield* Effect.all(
            ["owner-1", "owner-2"].map((id) =>
              Effect.result(
                members.remove(application, { organizationId: org.id, userId: userId(id) }),
              ),
            ),
            { concurrency: "unbounded" },
          );
          assert.strictEqual(yield* records.countOwners(org.id), 1, `round ${round}`);
        }
      }).pipe(Effect.provide(raceLayer())),
    );
  });
}
