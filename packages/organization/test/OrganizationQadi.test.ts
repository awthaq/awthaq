// Ticket 18 / spec.md's "qadi contribution": `Organization.relationships`
// and `Organization.attributes` are plain `Layer.effect` contributions an
// application composes into its own `QadiLive` by hand — proven here by
// composing them directly with a real `Organization` instance and calling
// `RelationshipResolver`/`AttributeResolver` straight, the same way an
// application's own qadi policy evaluation would reach them.
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AttributeResolver, makeResourceId, makeSubjectId, RelationshipResolver } from "@qadi/core";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationQadi from "../src/OrganizationQadi.ts";
import * as PermissionEngine from "../src/PermissionEngine.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("organization-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildOrganizationLive = (
  orgRolesLayer: Layer.Layer<OrgRoleRecords.OrgRoleRecords> = OrgRoleRecords.layerMemory.pipe(
    Layer.provide(NodeCrypto.layer),
  ),
) =>
  Organization.Organization.layer.pipe(
    Layer.provide(
      Organization.config({
        dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 10 },
        permissionStatements: { hr: { member: ["update"], invitation: ["create"] } },
        teams: {
          enabled: true,
          maximumTeams: Number.POSITIVE_INFINITY,
          maximumMembersPerTeam: Number.POSITIVE_INFINITY,
          allowRemovingAllTeams: false,
        },
      }),
    ),
    Layer.provide(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(orgRolesLayer),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const OrganizationLive = buildOrganizationLive();

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `session-${id}`,
  });

const buildQadiLive = (
  organizationLive: ReturnType<typeof buildOrganizationLive>,
  lookup: Layer.Layer<OrganizationQadi.ResourceOrganizationLookup> = OrganizationQadi
    .ResourceOrganizationLookup.layerNone,
) =>
  Layer.mergeAll(
    OrganizationQadi.relationships.pipe(Layer.provide(lookup)),
    OrganizationQadi.attributes,
  ).pipe(Layer.provideMerge(organizationLive));

const QadiLive = buildQadiLive(OrganizationLive);

const check = (relation: string, resourceId: string, userId: string, depth?: number) =>
  Effect.gen(function* () {
    const resolver = yield* RelationshipResolver;
    return yield* resolver.check({
      subjectId: makeSubjectId(`user:${userId}`),
      relation,
      resourceId: makeResourceId(resourceId),
      depth,
    });
  });

describe("OrganizationQadi", () => {
  it.effect("relationships resolves member/admin/owner/team-member and non-relations", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("admin-1"),
        role: ["admin"],
      });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });
      const team = yield* organization.createTeam(owner, record.id, "Engineering");
      yield* organization.addTeamMember(owner, record.id, team.id, Users.UserId("member-1"));

      const resolver = yield* RelationshipResolver;

      const memberIsMember = yield* resolver.check({
        subjectId: makeSubjectId("user:member-1"),
        relation: "member",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(memberIsMember, "Related");

      const strangerIsMember = yield* resolver.check({
        subjectId: makeSubjectId("user:stranger"),
        relation: "member",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(strangerIsMember, "Unrelated");

      const ownerIsOwner = yield* resolver.check({
        subjectId: makeSubjectId("user:owner-1"),
        relation: "owner",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(ownerIsOwner, "Related");

      const memberIsOwner = yield* resolver.check({
        subjectId: makeSubjectId("user:member-1"),
        relation: "owner",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(memberIsOwner, "Unrelated");

      const adminIsAdmin = yield* resolver.check({
        subjectId: makeSubjectId("user:admin-1"),
        relation: "admin",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(adminIsAdmin, "Related");

      const memberIsTeamMember = yield* resolver.check({
        subjectId: makeSubjectId("user:member-1"),
        relation: "team-member",
        resourceId: makeResourceId(team.id),
        depth: undefined,
      });
      assert.strictEqual(memberIsTeamMember, "Related");

      const adminIsTeamMember = yield* resolver.check({
        subjectId: makeSubjectId("user:admin-1"),
        relation: "team-member",
        resourceId: makeResourceId(team.id),
        depth: undefined,
      });
      assert.strictEqual(adminIsTeamMember, "Unrelated");

      // RZS-005: an unrecognised relation is qadi's "Unknown" (nobody can say),
      // not an honest-looking negative.
      const unknownRelation = yield* resolver.check({
        subjectId: makeSubjectId("user:member-1"),
        relation: "totally-unknown",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(unknownRelation, "Unknown");

      const nonUserSubject = yield* resolver.check({
        subjectId: makeSubjectId("apikey:some-key"),
        relation: "member",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(nonUserSubject, "Unrelated");
    }).pipe(Effect.provide(QadiLive)),
  );

  it.effect(
    "attributes resolves organizationCount/ownedOrganizationCount, and undefined otherwise",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const acme = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        yield* organization.create({ caller: owner, name: "Globex", slug: "globex" });
        yield* organization.addMember({
          organizationId: acme.id,
          userId: Users.UserId("member-1"),
          role: ["member"],
        });

        const attributeResolver = yield* AttributeResolver;

        const ownerCount = yield* attributeResolver.resolve(
          makeSubjectId("user:owner-1"),
          "organizationCount",
        );
        assert.strictEqual(ownerCount, 2);
        const ownerOwnedCount = yield* attributeResolver.resolve(
          makeSubjectId("user:owner-1"),
          "ownedOrganizationCount",
        );
        assert.strictEqual(ownerOwnedCount, 2);

        const memberCount = yield* attributeResolver.resolve(
          makeSubjectId("user:member-1"),
          "organizationCount",
        );
        assert.strictEqual(memberCount, 1);
        const memberOwnedCount = yield* attributeResolver.resolve(
          makeSubjectId("user:member-1"),
          "ownedOrganizationCount",
        );
        assert.strictEqual(memberOwnedCount, 0);

        const unknownAttribute = yield* attributeResolver.resolve(
          makeSubjectId("user:owner-1"),
          "somethingElse",
        );
        assert.isUndefined(unknownAttribute);

        const nonUserSubject = yield* attributeResolver.resolve(
          makeSubjectId("apikey:some-key"),
          "organizationCount",
        );
        assert.isUndefined(nonUserSubject);
      }).pipe(Effect.provide(QadiLive)),
  );

  // CWM-003/N9: removing a member also removes their team memberships, so qadi
  // stops answering `team-member` for them.
  it.effect("a removed member is no longer team-member of that organization's teams", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });
      const team = yield* organization.createTeam(owner, record.id, "Engineering");
      yield* organization.addTeamMember(owner, record.id, team.id, Users.UserId("member-1"));
      const resolver = yield* RelationshipResolver;
      const check = () =>
        resolver.check({
          subjectId: makeSubjectId("user:member-1"),
          relation: "team-member",
          resourceId: makeResourceId(team.id),
          depth: undefined,
        });
      assert.strictEqual(yield* check(), "Related");

      yield* organization.removeMember(owner, record.id, Users.UserId("member-1"));

      assert.strictEqual(yield* check(), "Unrelated");
    }).pipe(Effect.provide(QadiLive)),
  );

  // EP-003 (ADR-EA-018): a suspended organization confers nothing through qadi either.
  it.effect("a suspended organization confers no relationship, and reinstating restores it", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const records = yield* OrganizationRecords.OrganizationRecords;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, record.id, "Engineering");
      yield* organization.addTeamMember(owner, record.id, team.id, Users.UserId("owner-1"));
      const relations = () =>
        Effect.all([
          check("member", record.id, "owner-1"),
          check("owner", record.id, "owner-1"),
          check("member:update", record.id, "owner-1"),
          check("team-member", team.id, "owner-1"),
          check("team-role:member", team.id, "owner-1"),
        ]);
      assert.deepStrictEqual(yield* relations(), [
        "Related",
        "Related",
        "Related",
        "Related",
        "Related",
      ]);

      yield* records.setSuspended(record.id, Option.some(yield* DateTime.now));
      assert.deepStrictEqual(yield* relations(), [
        "Unrelated",
        "Unrelated",
        "Unrelated",
        "Unrelated",
        "Unrelated",
      ]);

      yield* records.setSuspended(record.id, Option.none());
      assert.strictEqual(yield* check("member", record.id, "owner-1"), "Related");
    }).pipe(Effect.provide(QadiLive)),
  );

  // OHS-004: `team-role:<name>` answers from the team membership row, and, like the
  // plugin's own gating, a role held on a team applies to its whole subtree.
  it.effect("team-role:<name> is Related on the team and its descendants, not on other teams", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("lead-1"),
        role: ["member"],
      });
      const eng = yield* organization.createTeam(owner, record.id, "Engineering");
      const platform = yield* organization.createTeam(owner, record.id, "Platform", eng.id);
      const sales = yield* organization.createTeam(owner, record.id, "Sales");
      yield* organization.addTeamMember(owner, record.id, eng.id, Users.UserId("lead-1"), ["lead"]);

      const lead = OrganizationQadi.relations.teamRole("lead");
      const chief = OrganizationQadi.relations.teamRole("chief");
      assert.strictEqual(yield* check(lead, eng.id, "lead-1"), "Related");
      assert.strictEqual(yield* check(lead, platform.id, "lead-1"), "Related");
      assert.strictEqual(yield* check(lead, sales.id, "lead-1"), "Unrelated");
      assert.strictEqual(yield* check(chief, eng.id, "lead-1"), "Unrelated");
      assert.strictEqual(yield* check(lead, "no-such-team", "lead-1"), "Unknown");
    }).pipe(Effect.provide(QadiLive)),
  );

  // RZS-005: malformed questions are distinguishable from negatives.
  it.effect("relations naming no organization or team answer Unknown, not Unrelated", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, record.id, "Engineering");

      assert.strictEqual(yield* check("member", "no-such-org", "owner-1"), "Unknown");
      assert.strictEqual(yield* check("admin", "no-such-org", "owner-1"), "Unknown");
      assert.strictEqual(yield* check("has-role:billing", "no-such-org", "owner-1"), "Unknown");
      assert.strictEqual(yield* check("member:update", "no-such-org", "owner-1"), "Unknown");
      assert.strictEqual(yield* check("team-member", "no-such-team", "owner-1"), "Unknown");
      // A team id is not an organization id, and vice versa.
      assert.strictEqual(yield* check("team-member", record.id, "owner-1"), "Unknown");
      assert.strictEqual(yield* check("member", team.id, "owner-1"), "Unknown");
      // A real organization the subject simply is not in is an honest negative.
      assert.strictEqual(yield* check("member", record.id, "stranger"), "Unrelated");
    }).pipe(Effect.provide(QadiLive)),
  );

  // RZS-006: one grammar, derived from the same functions requirePermission uses.
  describe("relation grammar (RZS-006)", () => {
    const setup = Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.createRole(owner, record.id, {
        role: "team-lead",
        permission: { team: ["create"] },
      });
      for (const [user, role] of [
        ["admin-1", "admin"],
        ["hr-1", "hr"],
        ["lead-1", "team-lead"],
        ["plain-1", "member"],
      ] as const) {
        yield* organization.addMember({
          organizationId: record.id,
          userId: Users.UserId(user),
          role: [role],
        });
      }
      return { organization, owner, record };
    });

    it.effect(
      "has-has-role:<name> answers for built-in, static-custom and dynamic roles alike",
      () =>
        Effect.gen(function* () {
          const { record } = yield* setup;
          assert.strictEqual(yield* check("has-role:owner", record.id, "owner-1"), "Related");
          assert.strictEqual(yield* check("has-role:admin", record.id, "admin-1"), "Related");
          assert.strictEqual(yield* check("has-role:hr", record.id, "hr-1"), "Related");
          assert.strictEqual(yield* check("has-role:team-lead", record.id, "lead-1"), "Related");
          assert.strictEqual(yield* check("has-role:team-lead", record.id, "plain-1"), "Unrelated");
          // admin/owner remain aliases of role:admin/role:owner.
          assert.strictEqual(yield* check("admin", record.id, "admin-1"), "Related");
          assert.strictEqual(yield* check("owner", record.id, "admin-1"), "Unrelated");
        }).pipe(Effect.provide(QadiLive)),
    );

    it.effect("a dynamic role granting team:create makes team:create Related", () =>
      Effect.gen(function* () {
        const { record } = yield* setup;
        assert.strictEqual(yield* check("team:create", record.id, "lead-1"), "Related");
        assert.strictEqual(yield* check("team:delete", record.id, "lead-1"), "Unrelated");
        assert.strictEqual(yield* check("team:create", record.id, "plain-1"), "Unrelated");
        assert.strictEqual(yield* check("member:update", record.id, "hr-1"), "Related");
      }).pipe(Effect.provide(QadiLive)),
    );

    it.effect("relations agree with requirePermission for every membership", () =>
      Effect.gen(function* () {
        const { organization, record } = yield* setup;
        const vocabulary = Object.entries(PermissionEngine.defaultStatements.owner).flatMap(
          ([resource, actions]) => actions.map((action) => [resource, action] as const),
        );
        for (const user of ["owner-1", "admin-1", "hr-1", "lead-1", "plain-1"]) {
          const attrs = yield* organization.attributesFor(record.id, Users.UserId(user));
          assert.isTrue(Option.isSome(attrs));
          if (Option.isNone(attrs)) continue;
          for (const [resource, action] of vocabulary) {
            const related = yield* check(`${resource}:${action}`, record.id, user);
            assert.strictEqual(
              related === "Related",
              PermissionEngine.hasPermission(attrs.value.permissions, resource, action),
              `${user} ${resource}:${action}`,
            );
          }
        }
        // ...and with the endpoints' own gating, not just its data source.
        const leadRelation = yield* check("team:create", record.id, "lead-1");
        const created = yield* organization
          .createTeam(asCaller("lead-1"), record.id, "Lead's team")
          .pipe(Effect.exit);
        assert.strictEqual(leadRelation === "Related", created._tag === "Success");
        const plainRelation = yield* check("team:create", record.id, "plain-1");
        const plainCreated = yield* organization
          .createTeam(asCaller("plain-1"), record.id, "Plain's team")
          .pipe(Effect.exit);
        assert.strictEqual(plainRelation === "Related", plainCreated._tag === "Success");
        const adminDelete = yield* check("organization:delete", record.id, "admin-1");
        const adminDeleted = yield* organization
          .delete(asCaller("admin-1"), record.id)
          .pipe(Effect.exit);
        assert.strictEqual(adminDelete === "Related", adminDeleted._tag === "Success");
      }).pipe(Effect.provide(QadiLive)),
    );
  });

  // RZS-004: member/role relations are one indexed membership lookup — they
  // never compute (or read the dynamic roles behind) the full statement set.
  it.effect("member and role relations perform no OrgRoleRecords read", () => {
    let reads = 0;
    const CountingOrgRoles = Layer.effect(
      OrgRoleRecords.OrgRoleRecords,
      Effect.gen(function* () {
        const inner = yield* OrgRoleRecords.OrgRoleRecords;
        return {
          ...inner,
          listByOrganization: (organizationId: string) => {
            reads += 1;
            return inner.listByOrganization(organizationId);
          },
        };
      }),
    ).pipe(Layer.provide(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))));
    return Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("admin-1"),
        role: ["admin"],
      });
      reads = 0;
      assert.strictEqual(yield* check("admin", record.id, "admin-1"), "Related");
      assert.strictEqual(yield* check("member", record.id, "admin-1"), "Related");
      assert.strictEqual(yield* check("has-role:admin", record.id, "admin-1"), "Related");
      assert.strictEqual(reads, 0);
      // A permission relation does need the statements (and so the dynamic roles).
      assert.strictEqual(yield* check("team:create", record.id, "admin-1"), "Related");
      assert.isAbove(reads, 0);
    }).pipe(Effect.provide(buildQadiLive(buildOrganizationLive(CountingOrgRoles))));
  });

  // RZS-001 (wayfinder ticket 13): depth >= 1 walks resource -> organization
  // through the application's own lookup; an unresolved walk fails closed.
  describe("member at depth >= 1 (RZS-001)", () => {
    const projects: Record<string, string> = {};
    const ProjectLookup = Layer.succeed(OrganizationQadi.ResourceOrganizationLookup, {
      organizationOf: (resourceId: string) =>
        resourceId === "boom"
          ? Effect.fail("lookup store is down")
          : Effect.succeed(Option.fromNullishOr(projects[resourceId])),
    });
    const WalkingQadiLive = buildQadiLive(OrganizationLive, ProjectLookup);

    it.effect("member at depth 2 walks project -> org via ResourceOrganizationLookup", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const record = yield* organization.create({
          caller: asCaller("owner-1"),
          name: "Acme",
          slug: "acme",
        });
        projects["project-1"] = record.id;
        assert.strictEqual(yield* check("member", "project-1", "owner-1", 2), "Related");
        assert.strictEqual(yield* check("member", "project-1", "stranger", 2), "Unrelated");
        // Depth 0 / undefined still treat the resource id as the organization id.
        assert.strictEqual(yield* check("member", record.id, "owner-1", 0), "Related");
        assert.strictEqual(yield* check("member", record.id, "owner-1"), "Related");
        assert.strictEqual(yield* check("member", "project-1", "owner-1"), "Unknown");
      }).pipe(Effect.provide(WalkingQadiLive)),
    );

    it.effect("an unresolved resource or a failing lookup is a RelationshipResolveError", () =>
      Effect.gen(function* () {
        const orphan = yield* check("member", "orphan-project", "owner-1", 2).pipe(Effect.flip);
        assert.strictEqual(orphan._tag, "RelationshipResolveError");
        const down = yield* check("member", "boom", "owner-1", 1).pipe(Effect.flip);
        assert.strictEqual(down._tag, "RelationshipResolveError");
      }).pipe(Effect.provide(WalkingQadiLive)),
    );

    it.effect(
      "depth >= 1 with the default layerNone fails RelationshipResolveError, never Unrelated",
      () =>
        Effect.gen(function* () {
          const failure = yield* check("member", "project-1", "owner-1", 2).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "RelationshipResolveError");
        }).pipe(Effect.provide(QadiLive)),
    );
  });
});
