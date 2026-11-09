// Plan 30 Part A (ADR-EA-040 decision 6, BEH-EA-237/284/288/330, PERS-005): the authorization matrix,
// generated from the policy table. `internal/policy.ts` names every authorized method's policy; this suite
// walks it and, for every organization-scoped entry, generates the probes its `_tag`, `feature` and `scope`
// imply. A new endpoint cannot ship without a policy entry (the table's `satisfies`) nor without an
// `invoke` and a `route` here (their mapped types), and an entry point that runs its steps in another
// order turns a generated case red.
import { Api } from "@awthaq/api";
import { AuditLog, Auth, Sessions, Users } from "@awthaq/core";
import { TestAuth, type UserAgent } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationApi from "../src/OrganizationApi.ts";
import * as OrganizationEvents from "../src/OrganizationEvents.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import type { OrganizationShape } from "../src/OrganizationShape.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import type * as PermissionEngine from "../src/PermissionEngine.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import { type Policy, policy } from "../src/internal/policy.ts";
import { addMember, grant } from "./support.ts";

// ---- the entries under test --------------------------------------------------------------

type Policies = typeof policy;
/** The methods that name an organization, a team or an invitation of one (29 of 41). */
type Scoped = {
  [K in keyof Policies]: Policies[K]["_tag"] extends
    | "Member"
    | "Statement"
    | "InvitationStatement"
    | "InvitationReader"
    ? K
    : never;
}[keyof Policies];

interface Ids {
  readonly organizationId: string;
  readonly teamId: string;
  readonly roleId: string;
  readonly invitationId: string;
  /** A plain member to act on. */
  readonly target: Users.UserId;
  /** A member already on `teamId`'s roster. */
  readonly crew: Users.UserId;
  readonly roles: ReadonlyArray<string>;
  readonly teamRoles: ReadonlyArray<string>;
  readonly permission: PermissionEngine.Statements;
}

type Invoke = (
  organization: OrganizationShape,
  caller: Api.UserPrincipal,
  ids: Ids,
) => Effect.Effect<unknown, { readonly _tag: string }>;

/** One call per scoped method; the mapped type makes a missing entry a compile error. */
const invoke: { readonly [K in Scoped]: Invoke } = {
  get: (o, c, ids) => o.get(c, ids.organizationId),
  getFull: (o, c, ids) => o.getFull(c, ids.organizationId),
  update: (o, c, ids) => o.update(c, ids.organizationId, { name: "Renamed" }),
  delete: (o, c, ids) => o.delete(c, ids.organizationId),
  listMembers: (o, c, ids) => o.listMembers(c, ids.organizationId),
  removeMember: (o, c, ids) => o.removeMember(c, ids.organizationId, ids.target),
  updateMemberRole: (o, c, ids) => o.updateMemberRole(c, ids.organizationId, ids.target, ids.roles),
  leave: (o, c, ids) => o.leave(c, ids.organizationId),
  invite: (o, c, ids) =>
    o.invite(c, ids.organizationId, { email: "new@example.com", role: ids.roles }),
  cancelInvitation: (o, c, ids) => o.cancelInvitation(c, ids.invitationId),
  getInvitation: (o, c, ids) => o.getInvitation(c, ids.invitationId),
  listInvitationsForOrganization: (o, c, ids) =>
    o.listInvitationsForOrganization(c, ids.organizationId),
  createRole: (o, c, ids) =>
    o.createRole(c, ids.organizationId, { role: "auditor", permission: ids.permission }),
  listRoles: (o, c, ids) => o.listRoles(c, ids.organizationId),
  getRole: (o, c, ids) => o.getRole(c, ids.organizationId, ids.roleId),
  updateRole: (o, c, ids) => o.updateRole(c, ids.organizationId, ids.roleId, ids.permission),
  deleteRole: (o, c, ids) => o.deleteRole(c, ids.organizationId, ids.roleId),
  createTeam: (o, c, ids) => o.createTeam(c, ids.organizationId, "Nested", ids.teamId),
  moveTeam: (o, c, ids) => o.moveTeam(c, ids.organizationId, ids.teamId, Option.none()),
  listTeamAncestors: (o, c, ids) => o.listTeamAncestors(c, ids.organizationId, ids.teamId),
  listTeamDescendants: (o, c, ids) => o.listTeamDescendants(c, ids.organizationId, ids.teamId),
  listTeams: (o, c, ids) => o.listTeams(c, ids.organizationId),
  listUserTeams: (o, c, ids) => o.listUserTeams(c, ids.organizationId),
  updateTeam: (o, c, ids) => o.updateTeam(c, ids.organizationId, ids.teamId, "Renamed"),
  removeTeam: (o, c, ids) => o.removeTeam(c, ids.organizationId, ids.teamId),
  listTeamMembers: (o, c, ids) => o.listTeamMembers(c, ids.organizationId, ids.teamId),
  addTeamMember: (o, c, ids) =>
    o.addTeamMember(c, ids.organizationId, ids.teamId, ids.target, ids.teamRoles),
  updateTeamMemberRole: (o, c, ids) =>
    o.updateTeamMemberRole(c, ids.organizationId, ids.teamId, ids.crew, ids.teamRoles),
  removeTeamMember: (o, c, ids) => o.removeTeamMember(c, ids.organizationId, ids.teamId, ids.crew),
};

const isScoped = (name: string): name is Scoped => Object.hasOwn(invoke, name);
const scoped: ReadonlyArray<{ readonly name: Scoped; readonly entry: Policy }> = Object.entries(
  policy,
).flatMap(([name, entry]) => (isScoped(name) ? [{ name, entry }] : []));

const onInvitation = (entry: Policy) =>
  entry._tag === "InvitationStatement" || entry._tag === "InvitationReader";
const notFoundTag = (entry: Policy) =>
  onInvitation(entry) ? "InvitationNotFound" : "OrganizationNotFound";
const featureOf = (entry: Policy) =>
  entry._tag === "Member" || entry._tag === "Statement" ? entry.feature : undefined;
const statementOf = (entry: Policy) =>
  entry._tag === "Statement" || entry._tag === "InvitationStatement" ? entry.statement : undefined;
const teamScoped = (entry: Policy) => entry._tag === "Statement" && entry.scope !== "organization";
const confers = (entry: Policy) => entry._tag === "Statement" && entry.confers;
/** The entries that take a role id (DA5 applies to them as to team ids). */
const roleIdEntries: ReadonlyArray<Scoped> = ["getRole", "updateRole", "deleteRole"];

// ---- composition and fixtures ------------------------------------------------------------

const allFeatures: Partial<Organization.OrganizationConfigShape> = {
  teams: {
    enabled: true,
    maximumTeams: Number.POSITIVE_INFINITY,
    maximumMembersPerTeam: Number.POSITIVE_INFINITY,
    allowRemovingAllTeams: true,
  },
  dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 10 },
  // `director` confers more than `lead`, so a lead conferring it is an escalation (OHS-004).
  teamStatements: { lead: { team: ["update"] }, director: { team: ["update", "delete"] } },
};

const built = Auth.make([Organization.Organization]);
const withFeatures = TestAuth.layer(built, { services: Organization.config(allFeatures) });
const withoutFeatures = TestAuth.layer(built, { services: Organization.config({}) });

const caller = (id: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });
const owner = caller("owner");
const admin = caller("admin");
const member = caller("member");
const lead = caller("lead");
const outsider = caller("outsider");

const join = (organizationId: string, id: string, role: ReadonlyArray<string>) =>
  addMember({ organizationId, userId: Users.UserId(id), role });

/**
 * Organization A (owner, admin, member, target, lead, crew; teams Platform > Eng with `lead` leading Eng and
 * `crew` on it; a dynamic role; a pending invitation) and organization B, where `member` also belongs and
 * leads B's own team, which also has a dynamic role.
 */
const arrange = Effect.gen(function* () {
  const organization = yield* Organization.Organization;
  const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
  yield* join(org.id, "admin", ["admin"]);
  yield* join(org.id, "member", ["member"]);
  yield* join(org.id, "target", ["member"]);
  yield* join(org.id, "lead", ["member"]);
  yield* join(org.id, "crew", ["member"]);
  const platform = yield* organization.createTeam(owner, org.id, "Platform");
  const eng = yield* organization.createTeam(owner, org.id, "Eng", platform.id);
  yield* organization.addTeamMember(owner, org.id, eng.id, Users.UserId("lead"), ["lead"]);
  yield* organization.addTeamMember(owner, org.id, eng.id, Users.UserId("crew"), ["member"]);
  const role = yield* organization.createRole(owner, org.id, {
    role: "billing",
    permission: { invitation: ["create"] },
  });
  const invitation = yield* organization.invite(owner, org.id, {
    email: "pending@example.com",
    role: ["member"],
  });

  const ownerB = caller("owner-b");
  const other = yield* organization.create({ caller: ownerB, name: "Beta", slug: "beta" });
  yield* join(other.id, "member", ["member"]);
  const foreignTeam = yield* organization.createTeam(ownerB, other.id, "Foreign");
  yield* organization.addTeamMember(ownerB, other.id, foreignTeam.id, Users.UserId("member"), [
    "lead",
  ]);
  const foreignRole = yield* organization.createRole(ownerB, other.id, {
    role: "foreign",
    permission: { invitation: ["create"] },
  });

  const ids: Ids = {
    organizationId: org.id,
    teamId: eng.id,
    roleId: role.id,
    invitationId: invitation.id,
    target: Users.UserId("target"),
    crew: Users.UserId("crew"),
    roles: ["admin"],
    teamRoles: ["lead"],
    permission: { invitation: ["create"] },
  };
  return { organization, ids, other, foreignTeam, foreignRole };
});

/** What a probe must leave untouched: the organization's rows, and every non-denial event. */
const snapshot = (organizationId: string) =>
  Effect.gen(function* () {
    const memberships = yield* MembershipRecords.MembershipRecords;
    const invitations = yield* InvitationRecords.InvitationRecords;
    const roles = yield* OrgRoleRecords.OrgRoleRecords;
    const teams = yield* TeamRecords.TeamRecords;
    const auditLog = yield* AuditLog.AuditLog;
    const teamRows = yield* teams.listTeamsByOrganization(organizationId);
    const rosters = yield* Effect.forEach(teamRows, (team) => teams.listTeamMembers(team.id));
    const events = yield* auditLog.list();
    return JSON.stringify({
      memberships: yield* memberships.listByOrganization(organizationId),
      invitations: yield* invitations.listByOrganization(organizationId),
      roles: yield* roles.listByOrganization(organizationId),
      teams: teamRows,
      rosters,
      events: events.filter((event) => event.eventTag !== "auth.organization.permissionDenied")
        .length,
    });
  });

const denials = Effect.flatMap(AuditLog.AuditLog, (auditLog) =>
  auditLog.list({ eventTag: "auth.organization.permissionDenied" }),
).pipe(
  Effect.map((records) =>
    records.flatMap((record) =>
      Option.toArray(
        AuditLog.payloadAs(OrganizationEvents.OrganizationPermissionDeniedEvent)(record),
      ),
    ),
  ),
);

const suspend = (organizationId: string) =>
  Effect.gen(function* () {
    const records = yield* OrganizationRecords.OrganizationRecords;
    yield* records.setSuspended(grant, organizationId, Option.some(yield* DateTime.now));
  });

const failureTag = (effect: Effect.Effect<unknown, { readonly _tag: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => failure._tag),
  );

// ---- the generated suite -----------------------------------------------------------------

describe("Authorization matrix (plan 30, generated from internal/policy.ts)", () => {
  it("covers every organization-scoped method", () => {
    assert.strictEqual(scoped.length, 29);
    assert.strictEqual(Object.keys(policy).length, 41);
  });

  for (const { name, entry } of scoped) {
    const call = invoke[name];
    const expected = notFoundTag(entry);
    const wanted = statementOf(entry);
    const feature = featureOf(entry);

    describe(name, () => {
      // MTI-009, EP-003: an outsider, an unknown id and a suspended organization are one answer.
      it.effect(
        `an outsider, an unknown id and a suspended organization all answer ${expected}`,
        () =>
          Effect.gen(function* () {
            const { organization, ids } = yield* arrange;
            const before = yield* snapshot(ids.organizationId);
            const existing = yield* failureTag(call(organization, outsider, ids));
            const unknown = yield* failureTag(
              call(organization, owner, {
                ...ids,
                organizationId: "no-such-organization",
                invitationId: "no-such-invitation",
              }),
            );
            assert.deepStrictEqual([existing, unknown], [expected, expected]);
            assert.strictEqual(yield* snapshot(ids.organizationId), before);
            yield* suspend(ids.organizationId);
            assert.strictEqual(yield* failureTag(call(organization, outsider, ids)), expected);
          }).pipe(Effect.provide(withFeatures)),
      );

      // PERS-005 (DA4): a statement-gated entry records an outsider's attempt; a read records nothing.
      it.effect(
        wanted === undefined
          ? "an outsider's read is not audited"
          : `an outsider's attempt is audited notMember ${wanted.resource}:${wanted.action}`,
        () =>
          Effect.gen(function* () {
            const { organization, ids } = yield* arrange;
            yield* failureTag(call(organization, outsider, ids));
            const recorded = yield* denials;
            if (wanted === undefined) {
              assert.strictEqual(recorded.length, 0);
              return;
            }
            assert.strictEqual(recorded.length, 1);
            assert.deepStrictEqual(
              {
                organizationId: recorded[0]?.organizationId,
                userId: recorded[0]?.userId,
                resource: recorded[0]?.resource,
                action: recorded[0]?.action,
                reason: recorded[0]?.reason,
              },
              {
                organizationId: ids.organizationId,
                userId: "outsider",
                resource: wanted.resource,
                action: wanted.action,
                reason: "notMember",
              },
            );
          }).pipe(Effect.provide(withFeatures)),
      );

      // EP-003 (A-F2, A-F3): a suspended organization refuses its own owner too.
      it.effect(`the owner of a suspended organization gets ${expected}`, () =>
        Effect.gen(function* () {
          const { organization, ids } = yield* arrange;
          yield* suspend(ids.organizationId);
          const before = yield* snapshot(ids.organizationId);
          assert.strictEqual(yield* failureTag(call(organization, owner, ids)), expected);
          assert.strictEqual(yield* snapshot(ids.organizationId), before);
        }).pipe(Effect.provide(withFeatures)),
      );

      it.effect("the happy path succeeds", () =>
        Effect.gen(function* () {
          const { organization, ids } = yield* arrange;
          // The last owner cannot leave; any other member can.
          yield* call(organization, name === "leave" ? member : owner, ids);
        }).pipe(Effect.provide(withFeatures)),
      );

      if (wanted !== undefined) {
        it.effect(
          `a member without ${wanted.resource}:${wanted.action} gets OrganizationPermissionDenied, audited missingStatement`,
          () =>
            Effect.gen(function* () {
              const { organization, ids } = yield* arrange;
              const before = yield* snapshot(ids.organizationId);
              assert.strictEqual(
                yield* failureTag(call(organization, member, ids)),
                "OrganizationPermissionDenied",
              );
              assert.strictEqual(yield* snapshot(ids.organizationId), before);
              const recorded = yield* denials;
              assert.strictEqual(recorded.length, 1);
              assert.deepStrictEqual(
                [recorded[0]?.resource, recorded[0]?.action, recorded[0]?.reason],
                [wanted.resource, wanted.action, "missingStatement"],
              );
            }).pipe(Effect.provide(withFeatures)),
        );
      }

      if (feature !== undefined) {
        const disabled = feature === "teams" ? "TeamsDisabled" : "DynamicAccessControlDisabled";
        // PV-300, BEH-EA-284 (A-F1 for every role entry): a non-member's answer never depends on a feature.
        it.effect(
          `with ${feature} off an outsider still gets ${expected}, and a member ${disabled}`,
          () =>
            Effect.gen(function* () {
              const organization = yield* Organization.Organization;
              const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
              yield* join(org.id, "member", ["member"]);
              const ids: Ids = {
                organizationId: org.id,
                teamId: "some-team",
                roleId: "some-role",
                invitationId: "some-invitation",
                target: Users.UserId("member"),
                crew: Users.UserId("member"),
                roles: ["member"],
                teamRoles: ["member"],
                permission: {},
              };
              const existing = yield* failureTag(call(organization, outsider, ids));
              const unknown = yield* failureTag(
                call(organization, outsider, { ...ids, organizationId: "no-such-organization" }),
              );
              assert.deepStrictEqual([existing, unknown], [expected, expected]);
              assert.strictEqual(yield* failureTag(call(organization, member, ids)), disabled);
            }).pipe(Effect.provide(withoutFeatures)),
        );
      }

      if (teamScoped(entry) || roleIdEntries.includes(name)) {
        // DA5, BEH-EA-284 (A-F7): a team or role of another organization, named under this one's path.
        it.effect(
          "naming another organization's team or role: 403 without the statement, not found with it, never a write",
          () =>
            Effect.gen(function* () {
              const { organization, ids, other, foreignTeam, foreignRole } = yield* arrange;
              const foreign = { ...ids, teamId: foreignTeam.id, roleId: foreignRole.id };
              const before = [yield* snapshot(ids.organizationId), yield* snapshot(other.id)];
              // `member` leads the foreign team in its own organization: that role confers nothing here.
              assert.strictEqual(
                yield* failureTag(call(organization, member, foreign)),
                "OrganizationPermissionDenied",
              );
              const held = yield* failureTag(call(organization, owner, foreign));
              assert.match(held, /NotFound$/);
              assert.notStrictEqual(held, "OrganizationNotFound");
              assert.deepStrictEqual(
                [yield* snapshot(ids.organizationId), yield* snapshot(other.id)],
                before,
              );
            }).pipe(Effect.provide(withFeatures)),
        );
      }

      if (confers(entry)) {
        // RRM-001, OHS-004 (BEH-EA-288): the system call is bounded by the ceiling minted with the proof.
        const conferrer = teamScoped(entry) ? lead : admin;
        it.effect(
          `a ${conferrer === lead ? "team lead" : "admin"} conferring more than it holds is refused RolePermissionEscalation`,
          () =>
            Effect.gen(function* () {
              const { organization, ids } = yield* arrange;
              const before = yield* snapshot(ids.organizationId);
              const escalation = {
                ...ids,
                roles: ["owner"],
                teamRoles: ["director"],
                permission: { organization: ["delete"] },
              };
              assert.strictEqual(
                yield* failureTag(call(organization, conferrer, escalation)),
                "RolePermissionEscalation",
              );
              assert.strictEqual(yield* snapshot(ids.organizationId), before);
            }).pipe(Effect.provide(withFeatures)),
        );
      }
    });
  }
});

// ---- the same not-found probes over the real HTTP handler -----------------------------------

interface Route {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const routes: {
  readonly [K in Scoped]: (organizationId: string, invitationId: string) => Route;
} = {
  get: (id) => ({ method: "GET", path: `/organization/${id}` }),
  getFull: (id) => ({ method: "GET", path: `/organization/${id}/full` }),
  update: (id) => ({ method: "PATCH", path: `/organization/${id}`, body: { name: "x" } }),
  delete: (id) => ({ method: "DELETE", path: `/organization/${id}` }),
  listMembers: (id) => ({ method: "GET", path: `/organization/${id}/members` }),
  removeMember: (id) => ({ method: "DELETE", path: `/organization/${id}/members/owner` }),
  updateMemberRole: (id) => ({
    method: "PATCH",
    path: `/organization/${id}/members/owner`,
    body: { role: ["member"] },
  }),
  leave: (id) => ({ method: "POST", path: `/organization/${id}/leave` }),
  invite: (id) => ({
    method: "POST",
    path: `/organization/${id}/invitations`,
    body: { email: "x@example.com", role: ["member"] },
  }),
  cancelInvitation: (_, invitation) => ({
    method: "POST",
    path: `/organization/invitations/${invitation}/cancel`,
  }),
  getInvitation: (_, invitation) => ({
    method: "GET",
    path: `/organization/invitations/${invitation}`,
  }),
  listInvitationsForOrganization: (id) => ({
    method: "GET",
    path: `/organization/${id}/invitations`,
  }),
  createRole: (id) => ({
    method: "POST",
    path: `/organization/${id}/roles`,
    body: { role: "pwn", permission: { organization: ["delete"] } },
  }),
  listRoles: (id) => ({ method: "GET", path: `/organization/${id}/roles` }),
  getRole: (id) => ({ method: "GET", path: `/organization/${id}/roles/some-role` }),
  updateRole: (id) => ({
    method: "PATCH",
    path: `/organization/${id}/roles/some-role`,
    body: { permission: { organization: ["delete"] } },
  }),
  deleteRole: (id) => ({ method: "DELETE", path: `/organization/${id}/roles/some-role` }),
  createTeam: (id) => ({ method: "POST", path: `/organization/${id}/teams`, body: { name: "x" } }),
  moveTeam: (id) => ({
    method: "PATCH",
    path: `/organization/${id}/teams/some-team/parent`,
    body: { parentId: null },
  }),
  listTeamAncestors: (id) => ({
    method: "GET",
    path: `/organization/${id}/teams/some-team/ancestors`,
  }),
  listTeamDescendants: (id) => ({
    method: "GET",
    path: `/organization/${id}/teams/some-team/descendants`,
  }),
  listTeams: (id) => ({ method: "GET", path: `/organization/${id}/teams` }),
  listUserTeams: (id) => ({ method: "GET", path: `/organization/${id}/teams/mine` }),
  updateTeam: (id) => ({
    method: "PATCH",
    path: `/organization/${id}/teams/some-team`,
    body: { name: "x" },
  }),
  removeTeam: (id) => ({ method: "DELETE", path: `/organization/${id}/teams/some-team` }),
  listTeamMembers: (id) => ({
    method: "GET",
    path: `/organization/${id}/teams/some-team/members`,
  }),
  addTeamMember: (id) => ({
    method: "POST",
    path: `/organization/${id}/teams/some-team/members`,
    body: { userId: "owner" },
  }),
  updateTeamMemberRole: (id) => ({
    method: "PATCH",
    path: `/organization/${id}/teams/some-team/members/owner`,
    body: { role: ["member"] },
  }),
  removeTeamMember: (id) => ({
    method: "DELETE",
    path: `/organization/${id}/teams/some-team/members/owner`,
  }),
};

describe("Authorization matrix over HTTP (MTI-009, BEH-EA-284)", () => {
  // Default configuration: teams and dynamic access control are off, so this is also the feature-off probe.
  it("an outsider gets a byte-identical 404 for an existing and an unknown id, on every scoped route", async () => {
    const app = TestAuth.app(TestAuth.layer(built), { baseUrl: "http://localhost:3000" });
    const signInAs = async (userId: string) => {
      const setCookie = await app.run(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
          return yield* TestAuth.sessionSetCookie(issued);
        }),
      );
      const browser = await app.agent();
      browser.cookies.receive(setCookie);
      return browser;
    };
    const send = (browser: UserAgent.UserAgent, route: Route) =>
      browser.request(
        route.method,
        route.path,
        route.body === undefined ? {} : { json: route.body },
      );
    const ownerBrowser = await signInAs("owner");
    const stranger = await signInAs("outsider");
    const created = await send(ownerBrowser, {
      method: "POST",
      path: "/organization",
      body: { name: "Acme", slug: "acme" },
    });
    const org = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());
    const invited = await send(ownerBrowser, {
      method: "POST",
      path: `/organization/${org.id}/invitations`,
      body: { email: "pending@example.com", role: ["member"] },
    });
    const invitation = Schema.decodeUnknownSync(OrganizationApi.InvitationDto)(
      await invited.json(),
    );
    for (const { name } of scoped) {
      const route = routes[name];
      const existing = await send(stranger, route(org.id, invitation.id));
      const unknown = await send(stranger, route("no-such-organization", "no-such-invitation"));
      assert.strictEqual(existing.status, 404, name);
      assert.strictEqual(unknown.status, 404, name);
      assert.strictEqual(await existing.text(), await unknown.text(), name);
    }
  });
});
