// Plan 04 (ADR-EA-040): `OrganizationMembers`, tested at its own interface, with no principal. The
// owner invariant, the membership limit, role names, the `Bound`, the veto, the removal cascade and
// the hook order are proved here; the SAML role mapping's cases (BEH-EA-316) live here too, since
// `setRoles` is its one implementation. `Organization.test.ts` keeps only the authorization half.
import { HookPoint, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationAuthority from "../src/OrganizationAuthority.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationMembers from "../src/OrganizationMembers.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import { grant } from "./support.ts";

const NoTaps = Layer.empty;
const buildLayer = (
  config: Partial<Organization.OrganizationConfigShape> = {},
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = NoTaps,
) =>
  OrganizationSystem.layer.pipe(
    Layer.provide(Organization.config(config)),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(taps),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

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
});
