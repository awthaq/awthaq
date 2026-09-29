// Wayfinder ticket 12 (PCS-001/PCS-002/PCS-005): a revoked membership must
// not keep answering Allow from an application-scoped `DecisionCache`.
//
// `DecisionCache`'s key is the whole subject plus policy/resource/action, so
// a grant revoked in a *store the evaluation consults* (here the
// `OrganizationQadi.relationships` membership lookup) is invisible to the
// key. `DecisionCacheInvalidationLive` closes that for the state awthaq's own
// plugins own by clearing the cache on every organization observe hook.
//
// **One layer build for the whole file.** A hook point's registry freezes at
// its first `run()` within a composition (BEH-EA-024), so
// `DecisionCacheInvalidationLive` is built once per composition — exactly the
// "provide once, application-wide" rule its own doc comment states.
// `layer(...)` from `@effect/vitest` builds `AppLive` once and every test
// below shares it (each test uses its own organization/user ids, so shared
// state cannot leak between them).
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationQadi,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, layer } from "@effect/vitest";
import {
  currentSubjectLayer,
  decisionCacheLayer,
  DecisionCache,
  eq,
  evaluate,
  EvaluationServicesNone,
  hasAttribute,
  hasRelationship,
  isAllowed,
  literal,
  makeSubject,
} from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as DecisionCacheInvalidation from "../src/DecisionCacheInvalidation.ts";
import * as Resolvers from "../src/Resolvers.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
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
      secret: Redacted.make("decision-cache-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const records = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide(NodeCrypto.layer));

const OrganizationLive = Organization.Organization.layer.pipe(
  Layer.provide(
    Organization.config({
      dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 10 },
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
  Layer.provideMerge(records(OrganizationRecords.layerMemory)),
  Layer.provideMerge(records(MembershipRecords.layerMemory)),
  Layer.provideMerge(ActiveContextRecords.layerMemory),
  Layer.provideMerge(records(InvitationRecords.layerMemory)),
  Layer.provideMerge(records(OrgRoleRecords.layerMemory)),
  Layer.provideMerge(records(TeamRecords.layerMemory)),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
);

// The app-scoped cache, plus the opt-in bridge that keeps it honest.
const RelationshipsLive = OrganizationQadi.relationships.pipe(
  Layer.provide(OrganizationQadi.ResourceOrganizationLookup.layerNone),
);

const AppLive = Layer.mergeAll(
  EvaluationServicesNone,
  RelationshipsLive,
  Resolvers.UserAttributes,
  DecisionCacheInvalidation.DecisionCacheInvalidationLive,
).pipe(
  Layer.provideMerge(decisionCacheLayer({ capacity: 64 })),
  Layer.provideMerge(OrganizationLive),
);

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `session-${id}`,
  });

const decide = (relation: string, resourceId: string, userId: string) =>
  evaluate(hasRelationship(relation), { resource: { id: resourceId } }).pipe(
    Effect.provide(currentSubjectLayer(makeSubject({ id: `user:${userId}` }))),
    Effect.map(isAllowed),
  );

describe("DecisionCacheInvalidationLive (application-scoped DecisionCache)", () => {
  layer(AppLive)((it) => {
    it.effect("the cache really serves a second identical decision (the hazard is real)", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const cache = yield* DecisionCache;
        const record = yield* organization.create({
          caller: asCaller("owner-hit"),
          name: "Hit",
          slug: "hit",
        });
        assert.isTrue(yield* decide("member", record.id, "owner-hit"));
        const sizeAfterFirst = yield* cache.size;
        assert.isTrue(yield* decide("member", record.id, "owner-hit"));
        assert.strictEqual(yield* cache.size, sizeAfterFirst);
        assert.isAbove(sizeAfterFirst, 0);
      }),
    );

    it.effect("removeMember clears the cache so the next check denies", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-rm");
        const record = yield* organization.create({ caller: owner, name: "Rm", slug: "rm" });
        yield* organization.addMember({
          organizationId: record.id,
          userId: Users.UserId("member-rm"),
          role: ["member"],
        });
        assert.isTrue(yield* decide("member", record.id, "member-rm"));

        yield* organization.removeMember(owner, record.id, Users.UserId("member-rm"));

        assert.isFalse(yield* decide("member", record.id, "member-rm"));
      }),
    );

    it.effect("leave clears the cache (PCS-002: leave() must run the remove-member hooks)", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-lv");
        const record = yield* organization.create({ caller: owner, name: "Lv", slug: "lv" });
        yield* organization.addMember({
          organizationId: record.id,
          userId: Users.UserId("member-lv"),
          role: ["member"],
        });
        assert.isTrue(yield* decide("member", record.id, "member-lv"));

        yield* organization.leave(asCaller("member-lv"), record.id);

        assert.isFalse(yield* decide("member", record.id, "member-lv"));
      }),
    );

    it.effect("updateMemberRole clears the cache so a demotion is visible", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-role");
        const record = yield* organization.create({ caller: owner, name: "Role", slug: "role" });
        yield* organization.addMember({
          organizationId: record.id,
          userId: Users.UserId("admin-role"),
          role: ["admin"],
        });
        assert.isTrue(yield* decide("admin", record.id, "admin-role"));

        yield* organization.updateMemberRole(owner, record.id, Users.UserId("admin-role"), [
          "member",
        ]);

        assert.isFalse(yield* decide("admin", record.id, "admin-role"));
      }),
    );

    it.effect("delete clears the cache so a removed organization stops answering member", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-del");
        const record = yield* organization.create({ caller: owner, name: "Del", slug: "del" });
        assert.isTrue(yield* decide("member", record.id, "owner-del"));

        yield* organization.delete(owner, record.id);

        assert.isFalse(yield* decide("member", record.id, "owner-del"));
      }),
    );

    // AAPS-005: awthaq-owned user attributes (emailVerified/name) are covered too.
    it.effect(
      "a cached Deny on hasAttribute(emailVerified) becomes Allow after Users.verifyEmail",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "verify-cache@example.com" },
            name: "Verify",
          });
          const policy = hasAttribute(Resolvers.userAttr("emailVerified"), eq(literal(true)));
          const ask = evaluate(policy).pipe(
            Effect.provide(currentSubjectLayer(makeSubject({ id: `user:${user.id}` }))),
            Effect.map(isAllowed),
          );
          assert.isFalse(yield* ask);
          assert.isFalse(yield* ask);

          yield* users.verifyEmail(user.id);

          assert.isTrue(yield* ask);
        }),
    );

    it.effect("removeTeamMember clears the cache so team-member denies", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-tm");
        const record = yield* organization.create({ caller: owner, name: "Tm", slug: "tm" });
        yield* organization.addMember({
          organizationId: record.id,
          userId: Users.UserId("member-tm"),
          role: ["member"],
        });
        const team = yield* organization.createTeam(owner, record.id, "Eng");
        yield* organization.addTeamMember(owner, record.id, team.id, Users.UserId("member-tm"));
        assert.isTrue(yield* decide("team-member", team.id, "member-tm"));

        yield* organization.removeTeamMember(owner, record.id, team.id, Users.UserId("member-tm"));

        assert.isFalse(yield* decide("team-member", team.id, "member-tm"));
      }),
    );
  });

  // The control: the identical scenario against a cache the bridge does NOT
  // watch shows the stale Allow the bridge exists to prevent.
  layer(
    Layer.mergeAll(EvaluationServicesNone, RelationshipsLive).pipe(
      Layer.provideMerge(OrganizationLive),
    ),
  )((it) => {
    it.effect(
      "without the bridge, an app-scoped cache keeps answering Allow after removeMember",
      () =>
        Effect.gen(function* () {
          const organization = yield* Organization.Organization;
          const owner = asCaller("owner-ctl");
          const record = yield* organization.create({ caller: owner, name: "Ctl", slug: "ctl" });
          yield* organization.addMember({
            organizationId: record.id,
            userId: Users.UserId("member-ctl"),
            role: ["member"],
          });
          assert.isTrue(yield* decide("member", record.id, "member-ctl"));

          yield* organization.removeMember(owner, record.id, Users.UserId("member-ctl"));

          // Stale: the cached Allow survives the revocation.
          assert.isTrue(yield* decide("member", record.id, "member-ctl"));
        }).pipe(Effect.provide(decisionCacheLayer({ capacity: 64 }))),
    );
  });
});
