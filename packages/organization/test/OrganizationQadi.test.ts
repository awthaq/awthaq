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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AttributeResolver, makeResourceId, makeSubjectId, RelationshipResolver } from "@qadi/core";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationQadi from "../src/OrganizationQadi.ts";
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
      secret: Redacted.make("organization-test-csrf-secret"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const OrganizationLive = Organization.Organization.layer.pipe(
  Layer.provide(
    Organization.config({
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
  Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
  Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
);

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `session-${id}`,
  });

const QadiLive = Layer.mergeAll(OrganizationQadi.relationships, OrganizationQadi.attributes).pipe(
  Layer.provideMerge(OrganizationLive),
);

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

      const unknownRelation = yield* resolver.check({
        subjectId: makeSubjectId("user:member-1"),
        relation: "totally-unknown",
        resourceId: makeResourceId(record.id),
        depth: undefined,
      });
      assert.strictEqual(unknownRelation, "Unrelated");

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
});
