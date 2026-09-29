// Ticket 20: `OrganizationQadi.test.ts` (ticket 18) already proves
// `Organization.relationships`/`Organization.attributes` answer correctly
// when called directly against the `RelationshipResolver`/`AttributeResolver`
// tags. This file proves the remaining half of ticket 20's own checklist —
// that the contribution also works once composed into a *real* qadi policy,
// evaluated through the real `evaluate`/`hasRelationship` API from
// `@qadi/core`, mirroring `usage-qadi.md` §7's own worked example
// (`hasRelationship("member", { depth: 2 })` inside a real policy).
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  currentSubjectLayer,
  evaluate,
  EvaluationServicesNone,
  hasRelationship,
  isAllowed,
  makeSubject,
} from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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
      secret: Redacted.make("organization-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildOrganizationLayer = (
  configOverrides: Partial<Organization.OrganizationConfigShape> = {},
) =>
  Organization.Organization.layer.pipe(
    Layer.provide(Organization.config(configOverrides)),
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

// `EvaluationServicesNone` bundles every optional evaluation port's
// fail-closed default (per `@qadi/core`'s own doc comment); merging
// `Organization.relationships` after it shadows only `RelationshipResolver`,
// exactly the "later-provided Layer shadows the earlier one for that tag"
// composition rule `spec/behaviors/21-qadi-resolvers-obligations.md` already
// documents for this class of contribution.
const buildQadiLayer = (configOverrides: Partial<Organization.OrganizationConfigShape> = {}) =>
  Layer.mergeAll(
    EvaluationServicesNone,
    OrganizationQadi.relationships.pipe(
      Layer.provide(OrganizationQadi.ResourceOrganizationLookup.layerNone),
    ),
  ).pipe(Layer.provideMerge(buildOrganizationLayer(configOverrides)));

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `session-${id}`,
  });

describe("Organization.relationships composed into a real qadi policy", () => {
  it.effect("hasRelationship('member') allows a real member and denies a real non-member", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const policy = hasRelationship("member");

      const memberDecision = yield* evaluate(policy, { resource: { id: record.id } }).pipe(
        Effect.provide(currentSubjectLayer(makeSubject({ id: "user:owner-1" }))),
      );
      assert.isTrue(isAllowed(memberDecision));

      const strangerDecision = yield* evaluate(policy, { resource: { id: record.id } }).pipe(
        Effect.provide(currentSubjectLayer(makeSubject({ id: "user:stranger-1" }))),
      );
      assert.isFalse(isAllowed(strangerDecision));
    }).pipe(Effect.provide(buildQadiLayer())),
  );

  it.effect(
    "hasRelationship('team-member') allows a real team member and denies a non-member",
    () =>
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

        const policy = hasRelationship("team-member");

        const teamMemberDecision = yield* evaluate(policy, { resource: { id: team.id } }).pipe(
          Effect.provide(currentSubjectLayer(makeSubject({ id: "user:member-1" }))),
        );
        assert.isTrue(isAllowed(teamMemberDecision));

        const nonTeamMemberDecision = yield* evaluate(policy, { resource: { id: team.id } }).pipe(
          Effect.provide(currentSubjectLayer(makeSubject({ id: "user:owner-1" }))),
        );
        assert.isFalse(isAllowed(nonTeamMemberDecision));
      }).pipe(
        Effect.provide(
          buildQadiLayer({
            teams: {
              enabled: true,
              maximumTeams: Number.POSITIVE_INFINITY,
              maximumMembersPerTeam: Number.POSITIVE_INFINITY,
              allowRemovingAllTeams: false,
            },
          }),
        ),
      ),
  );

  // RZS-006: a real policy over the plugin's own statement vocabulary allows
  // exactly the members the plugin's own PATCH gate allows — one source of truth.
  it.effect(
    "hasRelationship('member:update') agrees with the plugin's own updateMemberRole gate",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        for (const [user, role] of [
          ["hr-1", "hr"],
          ["plain-1", "member"],
          ["target-1", "member"],
        ] as const) {
          yield* organization.addMember({
            organizationId: record.id,
            userId: Users.UserId(user),
            role: [role],
          });
        }
        const policy = hasRelationship("member:update");
        for (const user of ["owner-1", "hr-1", "plain-1"]) {
          const decision = yield* evaluate(policy, { resource: { id: record.id } }).pipe(
            Effect.provide(currentSubjectLayer(makeSubject({ id: `user:${user}` }))),
          );
          const attempt = yield* organization
            .updateMemberRole(asCaller(user), record.id, Users.UserId("target-1"), ["member"])
            .pipe(Effect.exit);
          assert.strictEqual(isAllowed(decision), attempt._tag === "Success", user);
        }
      }).pipe(
        Effect.provide(buildQadiLayer({ permissionStatements: { hr: { member: ["update"] } } })),
      ),
  );
});
