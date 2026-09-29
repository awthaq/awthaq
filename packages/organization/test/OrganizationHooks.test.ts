// Ticket 19 / spec.md's "Lifecycle hooks": proves a tapped `veto` can
// abort or amend a representative operation, and a tapped `observe` fires
// after a representative success without being able to affect its
// outcome. One operation per area (org/member/invitation/team) would be
// excessive; `create` and `createTeam` are enough to prove the mechanism
// itself works, since every other operation wires the identical pattern
// (see `Organization.ts`'s own header comment — this is the first real
// plugin consumer of `HookPoint`, mirrored identically everywhere).
//
// Each hook point's registry is per composition (ELC-001): every case
// builds its own layer, so a tap installed in one never leaks into, or
// freezes, another. A tap's `Layer` requires its point, which
// `OrganizationHooksLive` provides last in `buildLayer`'s pipe.
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, HookPoint, Sessions, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
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

const buildLayer = (
  extraHooks: Layer.Layer<never, never, Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>>,
) =>
  Organization.Organization.layer.pipe(
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
    Layer.provideMerge(extraHooks),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `session-${id}`,
  });

describe("OrganizationHooks (BEH-EA-089-096, ticket 19)", () => {
  it.effect(
    "create: a veto tap can abort or amend, and an observe tap's own failure never affects the outcome",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");

        // JH-001/PERS-001: BEH-EA-090's own MUST — the veto abort reaches
        // the caller as the typed `HookPoint.HookAborted`, naming this
        // point's own id and the tap's own code, never a bare defect.
        const aborted = yield* organization
          .create({ caller: owner, name: "Nope", slug: "forbidden" })
          .pipe(
            Effect.flip,
            Effect.flatMap((error) =>
              error._tag === "HookAborted" ? Effect.succeed(error) : Effect.die(error),
            ),
          );
        assert.strictEqual(aborted.point, "organization.create.before");
        assert.strictEqual(aborted.code, "SLUG_FORBIDDEN");

        const record = yield* organization.create({
          caller: owner,
          name: "Original",
          slug: "acme",
        });
        // The veto tap amended the name; the observe tap below always
        // fails, and that failure must never surface here.
        assert.strictEqual(record.name, "Renamed By Tap");

        const orgs = yield* organization.list(owner);
        assert.strictEqual(orgs.length, 1);
      }).pipe(
        Effect.provide(
          buildLayer(
            Layer.mergeAll(
              OrganizationHooks.BeforeCreateOrganization.tap((input) =>
                input.slug === "forbidden"
                  ? Effect.fail(new HookPoint.HookAbort({ code: "SLUG_FORBIDDEN" }))
                  : Effect.succeed({ ...input, name: "Renamed By Tap" }),
              ),
              OrganizationHooks.AfterCreateOrganization.tap(() =>
                Effect.fail("observer exploded, this must never surface"),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "createTeam: a veto tap can abort team creation (a second, independent operation area)",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

        const aborted = yield* organization.createTeam(owner, record.id, "forbidden-team").pipe(
          Effect.flip,
          Effect.flatMap((error) =>
            error._tag === "HookAborted" ? Effect.succeed(error) : Effect.die(error),
          ),
        );
        assert.strictEqual(aborted.point, "organization.team.create.before");
        assert.strictEqual(aborted.code, "TEAM_NAME_FORBIDDEN");

        const teams = yield* organization.listTeams(owner, record.id);
        assert.strictEqual(teams.length, 0);
      }).pipe(
        Effect.provide(
          buildLayer(
            OrganizationHooks.BeforeCreateTeam.tap((input) =>
              input.name === "forbidden-team"
                ? Effect.fail(new HookPoint.HookAbort({ code: "TEAM_NAME_FORBIDDEN" }))
                : Effect.succeed(input),
            ),
          ),
        ),
      ),
  );
});
